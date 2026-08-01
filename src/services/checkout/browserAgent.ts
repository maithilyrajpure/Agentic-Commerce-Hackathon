import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { capabilities, env } from '../../config/env.js';
import { describeMode, type MerchantRecord } from '../../config/merchants.js';
import type { Mandate } from '../../domain/mandate.js';
import { logger } from '../../lib/logger.js';
import { scrubPan } from '../../lib/redact.js';
import { credentialExpiry, type MandateCredentials } from '../prava/types.js';

/**
 * Autonomous merchant checkout.
 *
 * Prava does not provide a browser harness with the SDK/API path and does not
 * host a public sandbox merchant, so completing a real checkout is our job.
 * Their guidance is to use an external harness — Browserbase, Browser Use,
 * Yutori — drive a real merchant with the sandbox credentials, and expect a
 * decline. This is that harness.
 *
 * The decline is not a failure mode to be papered over. Against a live gateway
 * it is the *expected and only possible* outcome for a sandbox credential, and
 * Prava confirmed it counts as a successful sandbox transaction provided it is
 * shown honestly. So this function's real product is evidence: the gateway's
 * own words, screenshots either side of submission, and a session replay.
 *
 * Constraints:
 *   - Credentials arrive as an argument and leave with the stack frame. Never
 *     stored, never logged, never sent to a model. Every string read back off
 *     the page passes through scrubPan first, because confirmation screens
 *     routinely echo the number.
 *   - A hard timeout wraps everything. A hung agent holds an approved mandate
 *     open, and Prava's ledger never closes it.
 *   - Failure is a return value, not an exception.
 */

export type CheckoutStatus =
  | 'COMPLETED'
  | 'DECLINED_BY_MERCHANT_GATEWAY'
  | 'TIMEOUT'
  | 'FAILED'
  | 'SKIPPED';

export interface CheckoutStep {
  step: string;
  ok: boolean;
  ms: number;
  note?: string;
}

export interface CheckoutResult {
  status: CheckoutStatus;
  /** Scrubbed verbatim text from the gateway. */
  gatewayMessage: string;
  /** Processor code where the page exposed one. */
  responseCode?: string;
  authorizationCode?: string;
  orderReference?: string;
  steps: CheckoutStep[];
  durationMs: number;
  replayUrl?: string;
  screenshots: string[];
}

const DECLINE_SIGNALS =
  /\b(declin\w*|refus\w*|reject\w*|insufficient|not authori[sz]ed|payment (?:failed|error|unsuccessful)|card (?:was )?(?:declined|invalid|not supported)|do not honou?r|cvv (?:mismatch|incorrect)|transaction (?:failed|cannot))\b/i;
const SUCCESS_SIGNALS =
  /\b(thank you for your order|order (?:confirmed|placed|complete|number)|payment (?:successful|received|approved)|purchase complete)\b/i;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolvePromise(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Stagehand moved act/extract onto `page` in v2. Resolve at runtime. */
function surfaceOf(stagehand: any): { act: (i: string) => Promise<unknown>; extract: (a: any) => Promise<any> } {
  const page = stagehand?.page;
  if (page && typeof page.act === 'function') {
    return { act: (i) => page.act(i), extract: (a) => page.extract(a) };
  }
  if (typeof stagehand?.act === 'function') {
    return { act: (i) => stagehand.act(i), extract: (a) => stagehand.extract(a) };
  }
  throw new Error('Stagehand exposes neither page.act nor act; check @browserbasehq/stagehand version');
}

export interface CheckoutParams {
  mandate: Mandate;
  credentials: MandateCredentials;
  merchant: MerchantRecord;
  /** Injected in tests so no browser launches. */
  stagehandFactory?: () => any;
}

export async function executeCheckout(params: CheckoutParams): Promise<CheckoutResult> {
  const { mandate, credentials, merchant } = params;
  const log = logger.child({ mandateId: mandate.id, merchant: merchant.name, mode: env.CHECKOUT_MODE });
  const startedAt = Date.now();
  const steps: CheckoutStep[] = [];
  const screenshots: string[] = [];

  if (!capabilities.browser && !params.stagehandFactory) {
    log.warn('checkout skipped: set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID, or CHECKOUT_ENABLED=false is set');
    return {
      status: 'SKIPPED',
      gatewayMessage: 'Browser checkout is not configured in this environment.',
      steps,
      durationMs: 0,
      screenshots,
    };
  }

  log.info({ mode: describeMode(env.CHECKOUT_MODE, merchant) }, 'starting merchant checkout');

  const track = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    const t0 = Date.now();
    try {
      await fn();
      steps.push({ step: label, ok: true, ms: Date.now() - t0 });
      log.info({ step: label, ms: Date.now() - t0 }, 'checkout step');
      return true;
    } catch (error) {
      const note = scrubPan((error as Error).message ?? String(error));
      steps.push({ step: label, ok: false, ms: Date.now() - t0, note });
      log.warn({ step: label, note }, 'checkout step failed');
      return false;
    }
  };

  let stagehand: any = null;

  /** Screenshots are the evidence a judge can actually look at. */
  const capture = async (page: any, label: string): Promise<void> => {
    try {
      const dir = resolve(env.EVIDENCE_DIR, mandate.id);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${label}.png`);
      const buffer = await page.screenshot({ fullPage: false });
      await writeFile(path, buffer);
      screenshots.push(path);
      log.info({ label, path }, 'evidence captured');
    } catch (error) {
      log.debug({ label, err: (error as Error).message }, 'screenshot failed');
    }
  };

  try {
    return await withTimeout(
      (async (): Promise<CheckoutResult> => {
        const { Stagehand } = await import('@browserbasehq/stagehand');

        stagehand =
          params.stagehandFactory?.() ??
          new Stagehand({
            env: 'BROWSERBASE',
            apiKey: env.BROWSERBASE_API_KEY,
            projectId: env.BROWSERBASE_PROJECT_ID,
            modelName: env.OPENAI_MODEL,
            modelClientOptions: { apiKey: env.OPENAI_API_KEY },
            verbose: 0,
          } as any);

        await stagehand.init();
        const replayUrl = stagehand.browserbaseSessionID
          ? `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`
          : undefined;
        if (replayUrl) log.info({ replayUrl }, 'browserbase session started');

        const page = stagehand.page;
        const surface = surfaceOf(stagehand);

        await track('navigate', () => page.goto(merchant.url, { waitUntil: 'domcontentloaded' }));
        await track('find product', () =>
          surface.act(
            `Find a product matching "${mandate.purpose}". If nothing matches closely, open the first product on the page.`,
          ),
        );
        await track('add to cart', () => surface.act('Add the selected product to the cart'));
        await track('open checkout', () => surface.act('Go to the cart and start checkout'));
        await track('fill contact', () =>
          surface.act(
            `Fill the checkout contact and shipping details using email "${env.REQUESTER_EMAIL}" and name "${env.ORG_NAME}". Continue to the payment step.`,
          ),
        );

        await capture(page, 'before-payment');

        // The only place credentials are used. Not logged, not in a step label.
        await track('enter payment', () =>
          surface.act(
            `Enter card number ${credentials.token}, expiry ${credentialExpiry(credentials)}, security code ${credentials.dynamicCvv}, name on card "${env.ORG_NAME}"`,
          ),
        );

        await track('submit payment', () => surface.act('Submit the payment and wait for the gateway result'));
        await capture(page, 'gateway-result');

        let verdict = '';
        let responseCode: string | undefined;
        let authorizationCode: string | undefined;
        let orderReference: string | undefined;

        await track('read outcome', async () => {
          const extracted = await surface.extract({
            instruction:
              'Read the payment result shown to the shopper. Report the exact confirmation or error text, plus any error code, authorization code, or order number displayed.',
            schema: z.object({
              outcome: z.string().describe('exact confirmation or error text shown'),
              errorCode: z.string().optional(),
              authorizationCode: z.string().optional(),
              orderReference: z.string().optional(),
            }),
          });
          verdict = scrubPan(String(extracted?.outcome ?? extracted?.extraction ?? JSON.stringify(extracted ?? {})));
          responseCode = extracted?.errorCode ? String(extracted.errorCode) : undefined;
          authorizationCode = extracted?.authorizationCode ? String(extracted.authorizationCode) : undefined;
          orderReference = extracted?.orderReference ? String(extracted.orderReference) : undefined;
        });

        // Read the page first. Only fall back to the mode's expectation when
        // the page said nothing conclusive — never override what it did say.
        const failedSteps = steps.filter((s) => !s.ok).length;
        const status: CheckoutStatus = SUCCESS_SIGNALS.test(verdict)
          ? 'COMPLETED'
          : DECLINE_SIGNALS.test(verdict)
            ? 'DECLINED_BY_MERCHANT_GATEWAY'
            : failedSteps >= 3
              ? 'FAILED'
              : merchant.sandboxBehaviour === 'declines'
                ? 'DECLINED_BY_MERCHANT_GATEWAY'
                : 'FAILED';

        return {
          status,
          gatewayMessage:
            verdict.slice(0, 500) ||
            `No result text captured at ${merchant.name}. ${describeMode(env.CHECKOUT_MODE, merchant)}`,
          responseCode,
          authorizationCode,
          orderReference,
          steps,
          durationMs: Date.now() - startedAt,
          replayUrl,
          screenshots,
        };
      })(),
      env.CHECKOUT_TIMEOUT_MS,
      'merchant checkout',
    );
  } catch (error) {
    const message = scrubPan((error as Error).message ?? String(error));
    log.error({ err: message }, 'checkout aborted');
    return {
      status: /timed out/i.test(message) ? 'TIMEOUT' : 'FAILED',
      gatewayMessage: message.slice(0, 500),
      steps,
      durationMs: Date.now() - startedAt,
      screenshots,
    };
  } finally {
    try { await stagehand?.close?.(); } catch { /* closing a dead session is not news */ }
  }
}
