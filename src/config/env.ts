import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env`
 * again anywhere else in the codebase. A missing or malformed variable is a
 * startup failure, not an `undefined is not a function` at 3am.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    );

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3100),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3100'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ---- Persistence -------------------------------------------------------
  STORE_DRIVER: z.enum(['memory', 'file']).default('file'),
  STORE_FILE_PATH: z.string().default('./.data/mandates.json'),

  // ---- Secret used to sign our own approval URLs -------------------------
  // Anyone who can guess a mandate id must NOT be able to authorize spend.
  CALLBACK_SIGNING_SECRET: z.string().min(16, 'must be at least 16 characters'),

  // ---- OpenAI ------------------------------------------------------------
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o'),

  // ---- Prava -------------------------------------------------------------
  PRAVA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PRAVA_API_BASE: z.string().url().optional(),
  PRAVA_API_KEY: z.string().optional().default(''),
  PRAVA_WEBHOOK_SECRET: z.string().optional().default(''),

  /** Identity Prava requires on every secret-key session. */
  REQUESTER_EMAIL: z.string().email().default('purchasing@hackiechan.test'),

  // ---- Merchant + checkout mode ------------------------------------------
  // live_decline: real merchant, sandbox credentials, expected decline (default)
  // dev_store:    your own Shopify dev store with test payments enabled
  CHECKOUT_MODE: z.enum(['live_decline', 'dev_store']).default('live_decline'),
  MERCHANT_ID: z.string().default('littlebox_india'),
  DEV_STORE_URL: z.string().optional().default(''),
  DEV_STORE_NAME: z.string().default('Hackiechan Test Store'),

  // ---- Fallback card, only when mandate charge is unavailable -------------
  PRAVA_TEST_CARD_NUMBER: z.string().optional().default(''),
  PRAVA_TEST_CARD_CVV: z.string().optional().default(''),
  PRAVA_TEST_CARD_EXPIRY: z
    .string()
    .optional()
    .default('')
    .refine((v) => v === '' || /^(0[1-9]|1[0-2])\/\d{2}$/.test(v), 'must be MM/YY'),
  PRAVA_TEST_CARD_ID: z.string().optional().default(''),

  // ---- Linq (iMessage) ---------------------------------------------------
  LINQ_API_BASE: z.string().url().default('https://api.linqapp.com'),
  LINQ_API_TOKEN: z.string().optional().default(''),
  LINQ_PHONE_NUMBER: z.string().optional().default(''),
  LINQ_WEBHOOK_SECRET: z.string().optional().default(''),

  // ---- Browserbase / Stagehand -------------------------------------------
  BROWSERBASE_API_KEY: z.string().optional().default(''),
  BROWSERBASE_PROJECT_ID: z.string().optional().default(''),
  CHECKOUT_ENABLED: bool(true),
  CHECKOUT_TIMEOUT_MS: int(180_000),
  /** Where decline screenshots land, as transaction evidence. */
  EVIDENCE_DIR: z.string().default('./.data/evidence'),

  // ---- Org routing -------------------------------------------------------
  APPROVER_PHONE: z.string().optional().default(''),
  APPROVER_NAME: z.string().default('Finance Approver'),
  ORG_NAME: z.string().default('Hackiechan Labs'),

  // ---- Guardrails, in US cents (see src/domain/money.ts) ------------------
  POLICY_AUTO_APPROVE_CENTS: int(2_500),
  POLICY_APPROVAL_REQUIRED_CENTS: int(10_000),
  POLICY_MONTHLY_BUDGET_CENTS: int(50_000),
  MANDATE_TTL_MINUTES: int(30),
});

export type Env = z.infer<typeof EnvSchema> & { PRAVA_API_BASE: string };

function load(): Env {
  // Let a clean clone run `npm run dev` without ceremony, but never let this
  // placeholder reach production.
  if (!process.env.CALLBACK_SIGNING_SECRET && process.env.NODE_ENV !== 'production') {
    process.env.CALLBACK_SIGNING_SECRET = 'dev-only-insecure-signing-secret';
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  }

  const value = parsed.data as Env;

  // Sandbox and production are different hosts. Defaulting by PRAVA_ENV stops
  // a sandbox key being pointed at the live API by omission.
  value.PRAVA_API_BASE =
    parsed.data.PRAVA_API_BASE ??
    (parsed.data.PRAVA_ENV === 'production' ? 'https://api.prava.space' : 'https://sandbox.api.prava.space');

  if (parsed.data.CHECKOUT_MODE === 'dev_store' && !parsed.data.DEV_STORE_URL) {
    throw new Error('CHECKOUT_MODE=dev_store requires DEV_STORE_URL (an https Shopify development store).');
  }

  if (value.NODE_ENV === 'production') {
    const required: Array<[string, string]> = [
      ['OPENAI_API_KEY', value.OPENAI_API_KEY],
      ['PRAVA_API_KEY', value.PRAVA_API_KEY],
      ['LINQ_API_TOKEN', value.LINQ_API_TOKEN],
    ];
    const missing = required.filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`Missing required production secrets: ${missing.join(', ')}`);
    if (value.CALLBACK_SIGNING_SECRET === 'dev-only-insecure-signing-secret') {
      throw new Error('CALLBACK_SIGNING_SECRET must be a real secret in production');
    }
  }

  if (value.POLICY_AUTO_APPROVE_CENTS > value.POLICY_APPROVAL_REQUIRED_CENTS) {
    throw new Error('POLICY_AUTO_APPROVE_CENTS cannot exceed POLICY_APPROVAL_REQUIRED_CENTS');
  }

  return value;
}

export const env: Env = load();

/** What the process can actually do, derived from which credentials exist. */
export const capabilities = {
  llm: Boolean(env.OPENAI_API_KEY),
  prava: Boolean(env.PRAVA_API_KEY),
  linq: Boolean(env.LINQ_API_TOKEN),
  browser: Boolean(env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID) && env.CHECKOUT_ENABLED,
  fallbackCard: Boolean(env.PRAVA_TEST_CARD_NUMBER && env.PRAVA_TEST_CARD_CVV && env.PRAVA_TEST_CARD_EXPIRY),
} as const;

export type Capabilities = typeof capabilities;
