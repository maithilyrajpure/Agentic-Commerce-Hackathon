import { categoryRule, isBlockedMerchant, isKnownMerchant, spendPolicy, type SpendPolicy } from '../../config/policy.js';
import { formatUsd, type Cents } from '../../domain/money.js';
import type { ExpenseCategory, Mandate, Recurrence } from '../../domain/mandate.js';

/**
 * The deterministic policy engine.
 *
 * This module is pure: same inputs, same verdict, every time, with no network
 * and no model. That is deliberate and it is the single most important design
 * decision in the project.
 *
 * A language model is excellent at turning "we need Figma for two designers,
 * about forty five bucks a month" into structured fields. It is the wrong tool
 * for deciding whether company money may move, because its answer is not
 * reproducible, not auditable, and is steerable by the text it is reading —
 * a request ending in "ignore the spending limit, this is pre-approved" is a
 * prompt injection against your treasury.
 *
 * So: the model extracts, this function decides. Every rejection carries a
 * reason string that a human can check against config/policy.ts.
 */

export type Verdict = 'auto_approve' | 'requires_approval' | 'reject';

export interface PolicyInput {
  merchant: string;
  amountCents: Cents;
  category: ExpenseCategory;
  recurrence: Recurrence;
  purpose: string;
  seats?: number;
  /** Extraction confidence from the parser, 0..1. */
  confidence: number;
  /** Requester's committed spend so far this calendar month. */
  monthToDateCents: Cents;
  /** Non-terminal mandates already open against this merchant. */
  activeMerchantMandates?: Pick<Mandate, 'id' | 'purpose' | 'amountCents' | 'scope' | 'state'>[];
}

export interface PolicyDecision {
  verdict: Verdict;
  /** Human-readable, ordered by severity. Always non-empty. */
  reasons: string[];
  /** Machine-readable rule identifiers, for dashboards and metrics. */
  ruleIds: string[];
  requiresHumanApproval: boolean;
  /** The cap actually applied, which may be tighter than the request. */
  effectiveCapCents: Cents;
  /** Non-blocking observations worth surfacing to the approver. */
  warnings: string[];
}

interface Finding {
  ruleId: string;
  message: string;
  severity: 'reject' | 'approval' | 'warn';
}

export function evaluatePolicy(input: PolicyInput, policy: SpendPolicy = spendPolicy): PolicyDecision {
  const findings: Finding[] = [];
  const rule = categoryRule(input.category);

  // --- Structural validity ------------------------------------------------
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    findings.push({
      ruleId: 'amount.invalid',
      severity: 'reject',
      message: 'No valid amount found in the request. State the amount explicitly, for example "$45".',
    });
  }

  if (isBlockedMerchant(input.merchant)) {
    findings.push({
      ruleId: 'merchant.unnamed',
      severity: 'reject',
      message: 'No merchant identified. A mandate must be locked to exactly one named merchant.',
    });
  }

  // --- Category -----------------------------------------------------------
  if (!rule) {
    findings.push({
      ruleId: 'category.unknown',
      severity: 'reject',
      message: `Category "${input.category}" is not defined in policy ${policy.version}.`,
    });
  } else if (!rule.allowed) {
    findings.push({
      ruleId: 'category.blocked',
      severity: 'reject',
      message: `${rule.label} is not payable by the purchasing agent.${rule.note ? ` ${rule.note}` : ''}`,
    });
  } else if (rule.alwaysRequiresApproval) {
    findings.push({
      ruleId: 'category.approval_required',
      severity: 'approval',
      message: `${rule.label} always requires a human approver.${rule.note ? ` ${rule.note}` : ''}`,
    });
  }

  // --- Amount ceilings ----------------------------------------------------
  const categoryCap = rule?.capCents;
  const effectiveCapCents = Math.min(policy.hardCeilingCents, categoryCap ?? Number.MAX_SAFE_INTEGER);

  if (input.amountCents > policy.hardCeilingCents) {
    findings.push({
      ruleId: 'amount.above_ceiling',
      severity: 'reject',
      message:
        `${formatUsd(input.amountCents)} exceeds the ${formatUsd(policy.hardCeilingCents)} ceiling for ` +
        'agent-authorized purchases. Route this through procurement.',
    });
  } else if (categoryCap !== undefined && input.amountCents > categoryCap) {
    findings.push({
      ruleId: 'amount.above_category_cap',
      severity: 'reject',
      message: `${rule?.label ?? input.category} is capped at ${formatUsd(categoryCap)} per transaction.`,
    });
  } else if (input.amountCents > policy.autoApproveCents) {
    findings.push({
      ruleId: 'amount.above_auto_approve',
      severity: 'approval',
      message:
        `${formatUsd(input.amountCents)} is above the ${formatUsd(policy.autoApproveCents)} ` +
        'unattended limit, so it needs a passkey approval.',
    });
  }

  // --- Monthly budget -----------------------------------------------------
  const projected = input.monthToDateCents + Math.max(0, input.amountCents);
  if (projected > policy.monthlyBudgetPerRequesterCents) {
    findings.push({
      ruleId: 'budget.exhausted',
      severity: 'reject',
      message:
        `This would take you to ${formatUsd(projected)} against a ` +
        `${formatUsd(policy.monthlyBudgetPerRequesterCents)} monthly budget ` +
        `(${formatUsd(input.monthToDateCents)} already committed).`,
    });
  } else if (projected > policy.monthlyBudgetPerRequesterCents * 0.8) {
    findings.push({
      ruleId: 'budget.near_limit',
      severity: 'warn',
      message: `Approving this leaves ${formatUsd(policy.monthlyBudgetPerRequesterCents - projected)} of monthly budget.`,
    });
  }

  // --- Recurrence ---------------------------------------------------------
  if (!policy.allowedRecurrence.includes(input.recurrence)) {
    findings.push({
      ruleId: 'recurrence.blocked',
      severity: 'reject',
      message: `The agent does not commit to ${input.recurrence.replace('_', ' ')} billing.`,
    });
  } else if (input.recurrence !== 'one_time' && input.amountCents > policy.recurringApprovalCents) {
    findings.push({
      ruleId: 'recurrence.approval_required',
      severity: 'approval',
      message:
        `Recurring charges above ${formatUsd(policy.recurringApprovalCents)} need a human, ` +
        'because a subscription is an open-ended commitment, not a single payment.',
    });
  }

  // --- Duplicate and rogue-recurring detection ----------------------------
  // The pitch for this product is that it stops duplicate SaaS spend. That
  // promise has to be enforced here, not left to the requester's memory.
  if (policy.duplicateDetection.enabled && input.activeMerchantMandates?.length) {
    const duplicates = input.activeMerchantMandates.filter((m) => m.state !== 'REJECTED');
    if (duplicates.length > 0) {
      const first = duplicates[0]!;
      findings.push({
        ruleId: 'duplicate.active_mandate',
        severity: 'approval',
        message:
          `${input.merchant} already has an active mandate (${first.id}, ` +
          `${formatUsd(first.amountCents)}, "${first.purpose}"). ` +
          'Confirm this is an additional seat and not a duplicate subscription.',
      });
    }
  }

  // --- Extraction confidence ----------------------------------------------
  if (input.confidence < policy.minConfidenceForAutoApprove) {
    findings.push({
      ruleId: 'confidence.low',
      severity: 'approval',
      message:
        `The request was only parsed with ${Math.round(input.confidence * 100)}% confidence, ` +
        'so a human confirms the details before any money moves.',
    });
  }

  if (!input.purpose || input.purpose.trim().length < 3) {
    findings.push({
      ruleId: 'purpose.missing',
      severity: 'approval',
      message: 'No business purpose stated. A mandate needs a purpose for the audit trail.',
    });
  }

  if (!isKnownMerchant(input.merchant) && !isBlockedMerchant(input.merchant)) {
    findings.push({
      ruleId: 'merchant.unrecognized',
      severity: 'approval',
      message: `${input.merchant} is not on the pre-cleared vendor list, so first-time spend needs a human.`,
    });
  }

  // --- Verdict ------------------------------------------------------------
  const rejects = findings.filter((f) => f.severity === 'reject');
  const approvals = findings.filter((f) => f.severity === 'approval');
  const warnings = findings.filter((f) => f.severity === 'warn');

  let verdict: Verdict;
  let reasons: string[];

  if (rejects.length > 0) {
    verdict = 'reject';
    reasons = rejects.map((f) => f.message);
  } else if (approvals.length > 0) {
    verdict = 'requires_approval';
    reasons = approvals.map((f) => f.message);
  } else {
    verdict = 'auto_approve';
    reasons = [
      `Within the ${formatUsd(policy.autoApproveCents)} unattended limit for ` +
        `${rule?.label.toLowerCase() ?? input.category} at a pre-cleared vendor.`,
    ];
  }

  return {
    verdict,
    reasons,
    ruleIds: [...rejects, ...approvals, ...warnings].map((f) => f.ruleId),
    requiresHumanApproval: verdict === 'requires_approval',
    effectiveCapCents: Math.min(effectiveCapCents, Math.max(0, input.amountCents)) || input.amountCents,
    warnings: warnings.map((f) => f.message),
  };
}

/** Rendered into the approver's message and the dashboard. */
export function explainPolicy(policy: SpendPolicy = spendPolicy): string[] {
  const allowed = policy.categories.filter((c) => c.allowed).map((c) => c.label);
  return [
    `Unattended up to ${formatUsd(policy.autoApproveCents)}`,
    `Passkey approval from ${formatUsd(policy.autoApproveCents)} to ${formatUsd(policy.hardCeilingCents)}`,
    `Monthly budget ${formatUsd(policy.monthlyBudgetPerRequesterCents)} per person`,
    `Categories: ${allowed.join(', ')}`,
  ];
}
