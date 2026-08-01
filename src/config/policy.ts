import { env } from './env.js';
import type { Cents } from '../domain/money.js';
import type { ExpenseCategory, Recurrence } from '../domain/mandate.js';

/**
 * The spend policy is data, not code, and it lives in exactly one place.
 *
 * A finance team should be able to read this file and know precisely what the
 * agent will and will not authorize, without reading TypeScript. Every rule
 * here is enforced by src/services/policy/engine.ts, which is pure and unit
 * tested — the language model never decides any of it.
 */

export interface CategoryRule {
  category: ExpenseCategory;
  label: string;
  allowed: boolean;
  /** Per-transaction ceiling for this category, if tighter than the global cap. */
  capCents?: Cents;
  /** Force human approval regardless of amount. */
  alwaysRequiresApproval?: boolean;
  note?: string;
}

export interface SpendPolicy {
  version: string;
  currency: 'USD';

  /** At or below this, the agent authorizes without a human. */
  autoApproveCents: Cents;
  /** Above this, no human can approve in-channel; it goes to procurement. */
  hardCeilingCents: Cents;
  /** Rolling calendar-month budget per requester. */
  monthlyBudgetPerRequesterCents: Cents;

  /** Minutes an unapproved mandate stays live before it expires. */
  mandateTtlMinutes: number;

  categories: readonly CategoryRule[];

  /** Merchants that are never permitted, whatever the category. */
  blockedMerchants: readonly string[];
  /** Merchants pre-cleared by procurement; skips the unknown-merchant flag. */
  knownMerchants: readonly string[];

  /** Recurrences the agent will commit the company to. */
  allowedRecurrence: readonly Recurrence[];
  /** Recurring commitments above this need a human even if under autoApprove. */
  recurringApprovalCents: Cents;

  /** Flag a request that duplicates an existing active mandate. */
  duplicateDetection: {
    enabled: boolean;
    windowDays: number;
  };

  /** Minimum extraction confidence before the agent will act unattended. */
  minConfidenceForAutoApprove: number;
}

export const spendPolicy: SpendPolicy = {
  version: '2026.08.01',
  currency: 'USD',

  autoApproveCents: env.POLICY_AUTO_APPROVE_CENTS,
  hardCeilingCents: env.POLICY_APPROVAL_REQUIRED_CENTS,
  monthlyBudgetPerRequesterCents: env.POLICY_MONTHLY_BUDGET_CENTS,
  mandateTtlMinutes: env.MANDATE_TTL_MINUTES,

  categories: [
    { category: 'software_subscription', label: 'Software subscription', allowed: true },
    { category: 'api_credits', label: 'API credits', allowed: true },
    { category: 'cloud_infrastructure', label: 'Cloud infrastructure', allowed: true },
    { category: 'developer_tools', label: 'Developer tools', allowed: true },
    { category: 'office_supplies', label: 'Office supplies', allowed: true, capCents: 5_000 },
    {
      category: 'hardware',
      label: 'Hardware',
      allowed: true,
      alwaysRequiresApproval: true,
      note: 'Capital purchase. Asset tagging required, so a human signs off regardless of amount.',
    },
    { category: 'travel', label: 'Travel', allowed: false, note: 'Book through the travel desk, not the agent.' },
    {
      category: 'meals_entertainment',
      label: 'Meals and entertainment',
      allowed: false,
      note: 'Submit as a reimbursement claim after the fact.',
    },
    {
      category: 'gift_cards',
      label: 'Gift cards',
      allowed: false,
      note: 'Stored-value instruments are outside agent authority.',
    },
    { category: 'other', label: 'Uncategorized', allowed: false, note: 'Name a category the policy recognizes.' },
  ],

  blockedMerchants: ['unknown', 'n/a', 'tbd'],

  knownMerchants: [
    'figma',
    'openai',
    'anthropic',
    'github',
    'vercel',
    'linear',
    'notion',
    'slack',
    'aws',
    'amazon web services',
    'google cloud',
    'cloudflare',
    'browserbase',
    'datadog',
    'sentry',
    'stripe',
    'littlebox india',
  ],

  allowedRecurrence: ['one_time', 'monthly'],
  recurringApprovalCents: 2_000,

  duplicateDetection: { enabled: true, windowDays: 35 },

  minConfidenceForAutoApprove: 0.75,
};

export function categoryRule(category: ExpenseCategory): CategoryRule | undefined {
  return spendPolicy.categories.find((c) => c.category === category);
}

export function isKnownMerchant(merchant: string): boolean {
  const needle = merchant.trim().toLowerCase();
  return spendPolicy.knownMerchants.some((m) => needle === m || needle.includes(m) || m.includes(needle));
}

export function isBlockedMerchant(merchant: string): boolean {
  const needle = merchant.trim().toLowerCase();
  return !needle || spendPolicy.blockedMerchants.some((m) => needle === m);
}
