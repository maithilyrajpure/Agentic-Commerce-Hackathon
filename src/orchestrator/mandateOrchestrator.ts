import { env } from '../config/env.js';
import { spendPolicy } from '../config/policy.js';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import {
  appendAudit,
  createMandate,
  isExpired,
  isTerminal,
  MandateState,
  transition,
  type Mandate,
} from '../domain/mandate.js';
import { formatUsd } from '../domain/money.js';
import { mintGrant } from '../lib/crypto.js';
import { logger, mandateLogger } from '../lib/logger.js';
import { last4 } from '../lib/redact.js';
import { getRepository } from '../store/index.js';
import type { MandateRepository } from '../store/types.js';
import { describeMode } from '../config/merchants.js';
import { executeCheckout, type CheckoutResult } from '../services/checkout/browserAgent.js';
import { linqClient, normalizePhone } from '../services/linq/client.js';
import * as copy from '../services/linq/templates.js';
import { evaluatePolicy, type PolicyDecision } from '../services/policy/engine.js';
import { extractExpense } from '../services/policy/extractor.js';
import { pravaClient, type ReportResult } from '../services/prava/client.js';

/**
 * The orchestrator owns the mandate lifecycle. It is the only module that may
 * advance a mandate's state, and therefore the only module through which money
 * can move.
 *
 * The rule it enforces, which the previous implementation did not:
 *
 *   No merchant checkout is ever started from the same call stack that sends an
 *   approval link.
 *
 * Authorization arrives later, out of band, over a signed URL, and lands in
 * `authorize()`. Until then the mandate sits in PENDING_APPROVAL and the state
 * machine refuses every transition that leads to a card. Approval is the event
 * that starts provisioning, not a formality that runs alongside it.
 */

export interface InboundResult {
  kind: 'mandate' | 'help' | 'status' | 'clarify' | 'ignored';
  mandate?: Mandate;
  reply?: string;
}

const HELP_RE = /^\s*(help|policy|rules|what can i (buy|expense)|commands?)\s*[?!.]*\s*$/i;
const STATUS_RE = /^\s*(status|pending|open|what'?s open|my requests?)\s*[?!.]*\s*$/i;

export class MandateOrchestrator {
  constructor(private readonly repo: MandateRepository) {}

  static async create(): Promise<MandateOrchestrator> {
    return new MandateOrchestrator(await getRepository());
  }

  // =========================================================================
  // Inbound
  // =========================================================================

  async handleInboundMessage(rawPhone: string, text: string): Promise<InboundResult> {
    const phone = normalizePhone(rawPhone);
    const log = logger.child({ requester: last4(phone) });

    if (HELP_RE.test(text)) {
      const reply = copy.helpMessage();
      await linqClient().send(phone, reply);
      return { kind: 'help', reply };
    }

    if (STATUS_RE.test(text)) {
      const open = (await this.repo.list({ requesterPhone: phone, limit: 20 })).filter((m) => !isTerminal(m.state));
      const reply = copy.statusMessage(open);
      await linqClient().send(phone, reply);
      return { kind: 'status', reply };
    }

    const extraction = await extractExpense(text);
    log.info(
      { source: extraction.source, merchant: extraction.merchant, confidence: extraction.confidence },
      'request extracted',
    );

    if (!extraction.isPurchaseRequest || (!extraction.merchant && extraction.amountCents === 0)) {
      const reply = copy.clarificationMessage(extraction.clarificationNeeded ?? '');
      await linqClient().send(phone, reply);
      return { kind: 'clarify', reply };
    }

    // ---- Build the mandate in DRAFT ------------------------------------
    const expiresAt = new Date(Date.now() + spendPolicy.mandateTtlMinutes * 60_000).toISOString();
    let mandate = createMandate({
      requesterPhone: phone,
      approverPhone: env.APPROVER_PHONE ? normalizePhone(env.APPROVER_PHONE) : undefined,
      rawRequest: text,
      purpose: extraction.purpose,
      amountCents: extraction.amountCents,
      seats: extraction.seats,
      scope: {
        merchant: extraction.merchant || 'unknown',
        perTransactionCapCents: extraction.amountCents,
        totalCapCents: extraction.amountCents,
        maxUses: 1,
        expiresAt,
        recurrence: extraction.recurrence,
        category: extraction.category,
      },
    });
    appendAudit(mandate, 'extractor', 'request.parsed', `${extraction.source}, confidence ${extraction.confidence}`);
    mandate = await this.repo.create(mandate);

    // ---- Deterministic policy ------------------------------------------
    const [monthToDateCents, activeMerchantMandates] = await Promise.all([
      this.repo.spendThisMonthCents(phone),
      this.repo.activeForMerchant(extraction.merchant || 'unknown'),
    ]);

    const decision = evaluatePolicy({
      merchant: mandate.scope.merchant,
      amountCents: mandate.amountCents,
      category: mandate.scope.category,
      recurrence: mandate.scope.recurrence,
      purpose: mandate.purpose,
      seats: mandate.seats,
      confidence: extraction.confidence,
      monthToDateCents,
      activeMerchantMandates: activeMerchantMandates
        .filter((m) => m.id !== mandate.id)
        .map((m) => ({ id: m.id, purpose: m.purpose, amountCents: m.amountCents, scope: m.scope, state: m.state })),
    });

    return this.applyDecision(mandate.id, decision);
  }

  private async applyDecision(mandateId: string, decision: PolicyDecision): Promise<InboundResult> {
    const mandate = await this.repo.withLock(mandateId, async (m) => {
      m.policyDecision = decision.verdict;
      m.policyReasons = decision.reasons;
      m.requiresHumanApproval = decision.requiresHumanApproval;
      m.scope.perTransactionCapCents = Math.min(m.scope.perTransactionCapCents, decision.effectiveCapCents);

      switch (decision.verdict) {
        case 'reject':
          transition(m, MandateState.REJECTED, 'policy-engine', decision.ruleIds.join(','));
          break;
        case 'auto_approve':
          transition(m, MandateState.AUTHORIZED, 'policy-engine', 'within unattended limit');
          m.authorizedAt = new Date().toISOString();
          m.authorizedBy = 'policy-engine (auto)';
          break;
        case 'requires_approval':
          transition(m, MandateState.PENDING_APPROVAL, 'policy-engine', decision.ruleIds.join(','));
          break;
      }
      return m;
    });

    const log = mandateLogger(mandate.id, { verdict: decision.verdict });

    if (decision.verdict === 'reject') {
      log.info({ ruleIds: decision.ruleIds }, 'mandate rejected by policy');
      await linqClient().send(mandate.requesterPhone, copy.rejectionMessage(mandate, decision), `reject:${mandate.id}`);
      return { kind: 'mandate', mandate };
    }

    if (decision.verdict === 'auto_approve') {
      log.info('mandate auto-authorized');
      await linqClient().send(mandate.requesterPhone, copy.autoApprovedMessage(mandate), `auto:${mandate.id}`);
      // Fire and forget: the requester already has their confirmation, and the
      // receipt arrives when the merchant responds.
      void this.provisionAndExecute(mandate.id).catch((err) =>
        log.error({ err: (err as Error).message }, 'auto-approved execution failed'),
      );
      return { kind: 'mandate', mandate };
    }

    // requires_approval: create the Prava session now so the approver's link is
    // backed by a real authorization object, then wait. Nothing is charged and
    // no card is issued until authorize() runs.
    const approveUrl = await this.prepareApproval(mandate.id);
    const fresh = await this.repo.require(mandate.id);

    const approver = fresh.approverPhone ?? fresh.requesterPhone;
    await linqClient().send(
      approver,
      copy.approvalRequestMessage(fresh, decision, approveUrl),
      `approval:${fresh.id}`,
    );
    if (approver !== fresh.requesterPhone) {
      await linqClient().send(
        fresh.requesterPhone,
        copy.pendingApprovalMessage(fresh, decision),
        `pending:${fresh.id}`,
      );
    }

    log.info({ approver: last4(approver) }, 'approval requested');
    return { kind: 'mandate', mandate: fresh };
  }

  /**
   * Create the Prava mandate-setup session and mint the signed approval URL.
   *
   * This session is authorize-only: Prava issues no credentials here. That is
   * the whole point — the approver's passkey establishes standing authority,
   * and credentials are minted later, per charge, against that authority.
   */
  private async prepareApproval(mandateId: string): Promise<string> {
    const mandate = await this.repo.require(mandateId);
    const callbackUrl = `${env.PUBLIC_BASE_URL}/authorize/callback`;
    const session = await pravaClient().createMandateSession(mandate, callbackUrl);

    await this.repo.withLock(mandateId, async (m) => {
      m.prava.sessionId = session.sessionId;
      m.prava.orderId = session.orderId;
      m.prava.authorizationUrl = session.approvalUrl || undefined;
      m.prava.pravaMandateStatus = session.degraded ? 'simulated' : 'pending';
      appendAudit(
        m,
        'prava',
        'mandate.setup_session',
        session.degraded
          ? `simulated (${session.degradedReason})`
          : `session ${session.sessionId}, authorizeOnly=${session.authorizeOnly}`,
      );
    });

    const grant = mintGrant(mandateId, 'approve', spendPolicy.mandateTtlMinutes);

    // When Prava returns its hosted passkey surface, that is the real
    // authorization UI. We send the approver there and have it redirect back to
    // our signed grant, so the return leg is verifiable rather than a bare id.
    if (session.approvalUrl) {
      try {
        const url = new URL(session.approvalUrl);
        url.searchParams.set('redirect_url', `${env.PUBLIC_BASE_URL}/authorize/callback?token=${grant}`);
        return url.toString();
      } catch {
        /* unparseable URL: fall through to our own page */
      }
    }
    return `${env.PUBLIC_BASE_URL}/authorize/${grant}`;
  }

  // =========================================================================
  // Authorization
  // =========================================================================

  /**
   * The only entry point that grants spend authority.
   *
   * Called from the signed-URL route after the approver completes their
   * passkey. Idempotent: a double-tap on the link, or a webhook racing the
   * redirect, results in one authorization and one checkout.
   */
  async authorize(mandateId: string, actor: string): Promise<Mandate> {
    const mandate = await this.repo.withLock(mandateId, async (m) => {
      if (m.state === MandateState.AUTHORIZED || m.state === MandateState.PROVISIONED || m.state === MandateState.EXECUTING) {
        appendAudit(m, actor, 'authorize.duplicate', 'already authorized, ignoring');
        return m;
      }
      if (isTerminal(m.state)) {
        throw new ConflictError(`Mandate ${m.id} is already ${m.state.toLowerCase()} and cannot be authorized`, {
          state: m.state,
        });
      }
      if (isExpired(m)) {
        transition(m, MandateState.EXPIRED, 'system', 'ttl elapsed before approval');
        throw new ConflictError(`Mandate ${m.id} expired before it was approved`, { state: m.state });
      }

      transition(m, MandateState.AUTHORIZED, actor, 'passkey verified');
      m.authorizedAt = new Date().toISOString();
      m.authorizedBy = actor;
      return m;
    });

    if (mandate.state === MandateState.AUTHORIZED && !mandate.executionLockedAt) {
      void this.provisionAndExecute(mandateId).catch((err) =>
        mandateLogger(mandateId).error({ err: (err as Error).message }, 'post-approval execution failed'),
      );
    }
    return mandate;
  }

  async reject(mandateId: string, actor: string, reason = 'declined by approver'): Promise<Mandate> {
    const mandate = await this.repo.withLock(mandateId, async (m) => {
      if (isTerminal(m.state)) return m;
      transition(m, MandateState.REJECTED, actor, reason);
      m.policyReasons = [`${actor} declined this request.`];
      return m;
    });
    await linqClient().send(
      mandate.requesterPhone,
      copy.rejectionMessage(mandate, {
        verdict: 'reject',
        reasons: [`${actor} declined this request.`],
        ruleIds: ['human.declined'],
        requiresHumanApproval: false,
        effectiveCapCents: mandate.amountCents,
        warnings: [],
      }),
      `human-reject:${mandate.id}`,
    );
    return mandate;
  }

  /**
   * Withdraw authority. Cancels the Prava session and kills the card upstream,
   * so a credential that has already been handed to the browser agent stops
   * working mid-flight.
   */
  async revoke(mandateId: string, actor: string, reason = 'revoked from dashboard'): Promise<Mandate> {
    const before = await this.repo.require(mandateId);
    if (isTerminal(before.state)) {
      throw new ConflictError(`Mandate ${mandateId} is already ${before.state.toLowerCase()}`, { state: before.state });
    }

    const revocation = await pravaClient().revoke(before);

    const mandate = await this.repo.withLock(mandateId, async (m) => {
      transition(m, MandateState.REVOKED, actor, reason);
      appendAudit(m, 'prava', 'credentials.revoked', revocation.detail);
      return m;
    });

    await linqClient().send(mandate.requesterPhone, copy.revokedMessage(mandate, actor), `revoke:${mandate.id}`);
    mandateLogger(mandateId).warn({ actor, detail: revocation.detail }, 'mandate revoked');
    return mandate;
  }

  // =========================================================================
  // Provisioning and execution
  // =========================================================================

  /**
   * Runs after authorization. Split into three phases so the long-running
   * browser work does not hold the mandate lock:
   *
   *   1. under lock  — claim the mandate, move AUTHORIZED -> PROVISIONED -> EXECUTING
   *   2. no lock     — issue the card, drive the merchant checkout (minutes)
   *   3. under lock  — record the outcome
   *
   * Holding the lock through phase 2 would make the dashboard's Revoke button
   * block for three minutes, which is exactly when you most want it to work.
   */
  async provisionAndExecute(mandateId: string): Promise<CheckoutResult | null> {
    const log = mandateLogger(mandateId);

    // --- Phase 1: claim -------------------------------------------------
    const claimed = await this.repo.withLock(mandateId, async (m) => {
      if (m.state !== MandateState.AUTHORIZED) {
        log.warn({ state: m.state }, 'execution requested for a mandate that is not authorized; refusing');
        return false;
      }
      if (m.executionLockedAt) {
        log.warn('execution already claimed; refusing duplicate');
        return false;
      }
      if (isExpired(m)) {
        transition(m, MandateState.EXPIRED, 'system', 'ttl elapsed before execution');
        return false;
      }
      m.executionLockedAt = new Date().toISOString();
      transition(m, MandateState.PROVISIONED, 'system', 'claiming credentials');
      return true;
    });

    if (!claimed) return null;

    // --- Phase 2: charge the mandate + checkout (no lock held) ----------
    let mandate = await this.repo.require(mandateId);
    let result: CheckoutResult;
    const prava = pravaClient();

    try {
      // Resolve Prava's mandate id. There is no create-mandate endpoint, so
      // after the passkey we match the mandate to the order we submitted.
      let pravaMandateId = mandate.prava.pravaMandateId;
      if (!pravaMandateId) {
        const found = await prava.findMandateForOrder(mandate.prava.orderId, mandate.id);
        pravaMandateId = found?.id;
        if (found) {
          await this.repo.withLock(mandateId, async (m) => {
            m.prava.pravaMandateId = found.id;
            m.prava.pravaMandateStatus = found.status;
            appendAudit(m, 'prava', 'mandate.resolved', `${found.id} (${found.status})`);
          });
        }
      }

      if (!pravaMandateId) {
        result = {
          status: 'SKIPPED',
          gatewayMessage:
            'No active Prava mandate found for this order. The passkey approval may not have completed.',
          steps: [],
          durationMs: 0,
          screenshots: [],
        };
      } else {
        // Mint single-use credentials against the standing authorization.
        const charge = await prava.chargeMandate(pravaMandateId, mandate);

        await this.repo.withLock(mandateId, async (m) => {
          m.prava.pravaMandateId = charge.pravaMandateId ?? pravaMandateId;
          m.prava.transactionId = charge.transactionId;
          if (charge.credentials) m.prava.cardLast4 = charge.credentials.token.slice(-4);
          appendAudit(
            m,
            'prava',
            charge.ok ? 'charge.credentials_minted' : 'charge.refused',
            charge.ok
              ? `txn ${charge.transactionId}, card ···${charge.credentials?.token.slice(-4) ?? '----'}`
              : charge.detail,
          );
        });

        if (!charge.ok || !charge.credentials) {
          // An over-cap charge lands here as THRESHOLD_EXCEEDED. That is the
          // card network enforcing the cap, not our code — worth surfacing
          // exactly as Prava worded it.
          result = {
            status: 'DECLINED_BY_MERCHANT_GATEWAY',
            gatewayMessage: `Prava refused the charge: ${charge.declineReason ?? charge.detail}`,
            steps: [],
            durationMs: 0,
            screenshots: [],
          };
        } else {
          mandate = await this.repo.withLock(mandateId, async (m) => {
            transition(m, MandateState.EXECUTING, 'browser-agent', `checkout at ${prava.merchant.name}`);
            return m;
          });
          result = await executeCheckout({
            mandate,
            credentials: charge.credentials,
            merchant: prava.merchant,
          });
        }
      }
    } catch (error) {
      result = {
        status: 'FAILED',
        gatewayMessage: (error as Error).message?.slice(0, 400) ?? 'charge failed',
        steps: [],
        durationMs: 0,
        screenshots: [],
      };
    }

    // --- Phase 3: record ------------------------------------------------
    return this.recordOutcome(mandateId, result);
  }

  private async recordOutcome(mandateId: string, result: CheckoutResult): Promise<CheckoutResult> {
    const log = mandateLogger(mandateId);
    const prava = pravaClient();
    const current = await this.repo.require(mandateId);
    const approved = result.status === 'COMPLETED';

    // Close the loop with the card network. Prava's guidance is explicit:
    // always report after using credentials, and report DECLINED when they were
    // used but checkout failed. Skipping this leaves the transaction awaiting a
    // result forever and the mandate's charge budget unreleased.
    const report =
      current.prava.pravaMandateId && current.prava.transactionId
        ? await prava.reportCharge(current.prava.pravaMandateId, current.prava.transactionId, {
            approved,
            authorizationCode: result.authorizationCode,
            responseCode: result.responseCode,
            amountCents: current.amountCents,
          })
        : ({ ok: false, detail: 'no charge to report' } as ReportResult);

    const mandate = await this.repo.withLock(mandateId, async (m) => {
      const target =
        result.status === 'COMPLETED'
          ? MandateState.COMPLETED
          : result.status === 'DECLINED_BY_MERCHANT_GATEWAY'
            ? MandateState.DECLINED
            : MandateState.FAILED;

      if (m.state === MandateState.EXECUTING) {
        transition(m, target, 'browser-agent', result.gatewayMessage.slice(0, 160));
      } else if (m.state === MandateState.PROVISIONED) {
        transition(m, MandateState.FAILED, 'system', 'checkout never started');
      }

      if (approved) m.scope.usesConsumed += 1;
      m.outcome = {
        status: result.status,
        gatewayMessage: result.gatewayMessage,
        completedAt: new Date().toISOString(),
        amountCapturedCents: approved ? m.amountCents : 0,
      };

      // The evidence pack. For a sandbox run against a live storefront this is
      // the deliverable: what the gateway said, what we showed it, and the
      // signed acknowledgement that we told Prava the truth about it.
      m.evidence = {
        checkoutMode: env.CHECKOUT_MODE,
        merchantName: prava.merchant.name,
        merchantUrl: prava.merchant.url,
        gatewayMessage: result.gatewayMessage,
        replayUrl: result.replayUrl,
        screenshots: result.screenshots,
        reportRequest: report.request as Record<string, unknown> | undefined,
        reportResponse: report.response as unknown as Record<string, unknown> | undefined,
        capturedAt: new Date().toISOString(),
      };

      m.prava.reportedStatus = report.request?.txn_status ?? (approved ? 'APPROVED' : 'DECLINED');
      m.prava.visaConfirmation = report.response?.visaConfirmation;
      if (report.response?.mandateStatus) m.prava.pravaMandateStatus = report.response.mandateStatus;

      appendAudit(m, 'prava', 'charge.reported', report.ok ? report.detail : `failed: ${report.detail}`);
      for (const step of result.steps) {
        appendAudit(m, 'browser-agent', `step.${step.ok ? 'ok' : 'fail'}`, `${step.step} (${step.ms}ms)`);
      }
      if (result.replayUrl) appendAudit(m, 'browser-agent', 'replay.available', result.replayUrl);
      return m;
    });

    log.info({ status: result.status, reported: report.ok, ms: result.durationMs }, 'mandate resolved');
    this.printDemoBanner(mandate, result, report.ok);

    await linqClient().send(mandate.requesterPhone, copy.receiptMessage(mandate), `receipt:${mandate.id}`);
    return result;
  }

  /** Single-line summary for the demo terminal and the video. */
  private printDemoBanner(mandate: Mandate, result: CheckoutResult, reported: boolean): void {
    const cells = [
      `POLICY ${mandate.policyDecision === 'auto_approve' ? 'auto' : 'pass'}`,
      `PRAVA MANDATE ${mandate.prava.pravaMandateId ? 'active' : 'none'}`,
      `PASSKEY ${mandate.authorizedBy?.includes('auto') ? 'not required' : 'verified'}`,
      `TOKEN ···${mandate.prava.cardLast4 ?? '----'}`,
      `CHECKOUT ${result.status}`,
      `REPORTED ${reported ? mandate.prava.reportedStatus : 'FAILED'}`,
      `VISA ${mandate.prava.visaConfirmation ?? 'n/a'}`,
    ];
    const bar = '═'.repeat(108);
    console.log(`\n${bar}\n  ${cells.join('  │  ')}`);
    console.log(`  ${describeMode(env.CHECKOUT_MODE, pravaClient().merchant)}`);
    if (result.replayUrl) console.log(`  replay: ${result.replayUrl}`);
    if (result.screenshots.length) console.log(`  evidence: ${result.screenshots.join(', ')}`);
    console.log(`${bar}\n`);
  }

  // =========================================================================
  // Maintenance
  // =========================================================================

  /**
   * Expire mandates whose TTL elapsed without approval.
   *
   * Without this an unapproved mandate sits in PENDING_APPROVAL forever and its
   * amount keeps counting against the requester's monthly budget. Runs on an
   * interval from index.ts.
   */
  async expireStale(): Promise<number> {
    const candidates = await this.repo.list({
      state: [MandateState.DRAFT, MandateState.PENDING_APPROVAL, MandateState.AUTHORIZED],
    });
    let expired = 0;

    for (const candidate of candidates) {
      if (!isExpired(candidate)) continue;
      try {
        const mandate = await this.repo.withLock(candidate.id, async (m) => {
          if (isTerminal(m.state) || !isExpired(m)) return null;
          transition(m, MandateState.EXPIRED, 'system', 'ttl elapsed');
          return m;
        });
        if (!mandate) continue;
        expired += 1;
        await linqClient().send(mandate.requesterPhone, copy.expiredMessage(mandate), `expired:${mandate.id}`);
      } catch (error) {
        logger.warn({ mandateId: candidate.id, err: (error as Error).message }, 'expiry sweep skipped a mandate');
      }
    }

    if (expired) logger.info({ expired }, 'expired stale mandates');
    return expired;
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async get(mandateId: string): Promise<Mandate> {
    const mandate = await this.repo.get(mandateId);
    if (!mandate) throw new NotFoundError('Mandate', mandateId);
    return mandate;
  }

  async list(limit = 50): Promise<Mandate[]> {
    return this.repo.list({ limit });
  }

  async summary(): Promise<{
    total: number;
    byState: Record<string, number>;
    committedCents: number;
    settledCents: number;
    blockedCents: number;
  }> {
    const all = await this.repo.list({ limit: 1000 });
    const byState: Record<string, number> = {};
    let committedCents = 0;
    let settledCents = 0;
    let blockedCents = 0;

    for (const m of all) {
      byState[m.state] = (byState[m.state] ?? 0) + 1;
      if (['AUTHORIZED', 'PROVISIONED', 'EXECUTING'].includes(m.state)) committedCents += m.amountCents;
      if (m.state === 'COMPLETED') settledCents += m.outcome?.amountCapturedCents ?? m.amountCents;
      if (['REJECTED', 'REVOKED'].includes(m.state)) blockedCents += m.amountCents;
    }

    return { total: all.length, byState, committedCents, settledCents, blockedCents };
  }
}

let singleton: MandateOrchestrator | null = null;
export async function orchestrator(): Promise<MandateOrchestrator> {
  if (!singleton) singleton = await MandateOrchestrator.create();
  return singleton;
}
export function setOrchestrator(instance: MandateOrchestrator | null): void {
  singleton = instance;
}
