import { randomUUID } from 'node:crypto';
import type { Cents } from './money.js';

/**
 * A Mandate is the unit of authority in this system.
 *
 * It is not a message, a request, or an intent. It is a scoped, revocable,
 * time-boxed grant of permission to move a bounded amount of company money to
 * one named merchant, for one named purpose, a bounded number of times.
 *
 * Everything else in the codebase — the LLM, the messaging layer, the browser
 * agent — is an actuator hanging off this record. None of them may spend money
 * except by advancing a Mandate through a legal transition.
 */

export const MandateState = {
  /** Parsed from natural language, not yet evaluated. */
  DRAFT: 'DRAFT',
  /** Deterministic policy engine rejected it. Terminal. */
  REJECTED: 'REJECTED',
  /** Waiting on a human approver's passkey. */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** A human (or auto-approve rule) granted authority. Spend is now permitted. */
  AUTHORIZED: 'AUTHORIZED',
  /** Prava has issued credentials scoped to this mandate. */
  PROVISIONED: 'PROVISIONED',
  /** The browser agent holds the lock and is at the merchant. */
  EXECUTING: 'EXECUTING',
  /** Merchant accepted the payment. Terminal. */
  COMPLETED: 'COMPLETED',
  /** Merchant or gateway declined. Terminal. */
  DECLINED: 'DECLINED',
  /** Execution failed for a non-payment reason. Terminal. */
  FAILED: 'FAILED',
  /** TTL elapsed before authorization. Terminal. */
  EXPIRED: 'EXPIRED',
  /** A human pulled the authority back. Terminal. */
  REVOKED: 'REVOKED',
} as const;

export type MandateState = (typeof MandateState)[keyof typeof MandateState];

/**
 * The transition table IS the security model. If a transition is not listed
 * here it cannot happen, regardless of what any caller believes.
 *
 * Read the EXECUTING row carefully: the only way in is from PROVISIONED, and
 * the only way to PROVISIONED is from AUTHORIZED. There is no path from
 * PENDING_APPROVAL to a merchant checkout. That is the whole point.
 */
const TRANSITIONS: Readonly<Record<MandateState, readonly MandateState[]>> = {
  DRAFT: [MandateState.REJECTED, MandateState.PENDING_APPROVAL, MandateState.AUTHORIZED, MandateState.EXPIRED],
  PENDING_APPROVAL: [MandateState.AUTHORIZED, MandateState.REJECTED, MandateState.EXPIRED, MandateState.REVOKED],
  AUTHORIZED: [MandateState.PROVISIONED, MandateState.FAILED, MandateState.EXPIRED, MandateState.REVOKED],
  PROVISIONED: [MandateState.EXECUTING, MandateState.FAILED, MandateState.EXPIRED, MandateState.REVOKED],
  EXECUTING: [MandateState.COMPLETED, MandateState.DECLINED, MandateState.FAILED],
  REJECTED: [],
  COMPLETED: [],
  DECLINED: [],
  FAILED: [],
  EXPIRED: [],
  REVOKED: [],
};

export const TERMINAL_STATES: readonly MandateState[] = [
  MandateState.REJECTED,
  MandateState.COMPLETED,
  MandateState.DECLINED,
  MandateState.FAILED,
  MandateState.EXPIRED,
  MandateState.REVOKED,
];

export function isTerminal(state: MandateState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: MandateState, to: MandateState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: MandateState): readonly MandateState[] {
  return TRANSITIONS[from] ?? [];
}

// ---------------------------------------------------------------------------

export type ExpenseCategory =
  | 'software_subscription'
  | 'api_credits'
  | 'cloud_infrastructure'
  | 'developer_tools'
  | 'office_supplies'
  | 'hardware'
  | 'travel'
  | 'meals_entertainment'
  | 'gift_cards'
  | 'other';

export type Recurrence = 'one_time' | 'monthly' | 'annual';

/** The envelope of authority. Every field here is a constraint, not a hint. */
export interface MandateScope {
  /** Merchant this mandate is locked to. Spend anywhere else is a violation. */
  merchant: string;
  /** Hard ceiling on a single authorization. */
  perTransactionCapCents: Cents;
  /** Hard ceiling on cumulative spend across all uses of this mandate. */
  totalCapCents: Cents;
  /** How many times the credential may be presented. */
  maxUses: number;
  /** Uses consumed so far. */
  usesConsumed: number;
  /** ISO timestamp after which the mandate is dead. */
  expiresAt: string;
  recurrence: Recurrence;
  category: ExpenseCategory;
}

/**
 * A message the agent actually sent to a person.
 *
 * The audit trail records that a notification happened; this records what it
 * said. Both matter, for different reasons: the audit answers "did the system
 * do the right thing", the transcript answers "did the human have what they
 * needed to decide". An approver disputing a purchase will ask the second
 * question, so the exact text has to survive.
 *
 * Safe to expose publicly: LinqClient.send runs scrubPan over every body before
 * dispatch, so nothing here can carry card data.
 */
export interface MessageRecord {
  at: string;
  direction: 'outbound';
  to: string;
  /** Short template name: approval_request, receipt, rejection, and so on. */
  kind: string;
  body: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  event: string;
  detail?: string;
  from?: MandateState;
  to?: MandateState;
}

export interface PravaBinding {
  /** Setup session that carried the passkey approval. */
  sessionId?: string;
  orderId?: string;
  /** Prava's own mandate id, resolved after approval. */
  pravaMandateId?: string;
  /** Prava's lifecycle status: pending / active / consumed / cancelled. */
  pravaMandateStatus?: string;
  /** Charge transaction id, needed to report the outcome. */
  transactionId?: string;
  /** Session line-item ref, needed to settle the session on Prava's dashboard. */
  txnRefId?: string;
  /** Result of the session-level settlement: APPROVED / DECLINED. */
  sessionReportedStatus?: string;
  /** Last four of the single-use network token. The token itself is never stored. */
  cardLast4?: string;
  authorizationUrl?: string;
  /** APPROVED or DECLINED, as reported to the card network. */
  reportedStatus?: string;
  visaConfirmation?: string;
}

/**
 * Everything needed to prove what happened at the merchant.
 *
 * For a sandbox run against a live storefront the decline IS the deliverable,
 * so it has to be captured properly rather than summarized away.
 */
export interface TransactionEvidence {
  checkoutMode: 'live_decline' | 'dev_store';
  merchantName: string;
  merchantUrl: string;
  /** Verbatim text the gateway showed the shopper. */
  gatewayMessage?: string;
  /** Browserbase session replay. */
  replayUrl?: string;
  /** Screenshot paths written to EVIDENCE_DIR. */
  screenshots: string[];
  /** Exact body sent to Prava's report endpoint. */
  reportRequest?: Record<string, unknown>;
  /** Exact body Prava returned. */
  reportResponse?: Record<string, unknown>;
  capturedAt: string;
}

export interface Mandate {
  id: string;
  state: MandateState;

  /** Who asked. */
  requesterPhone: string;
  requesterName?: string;
  /** Who must approve, when approval is required. */
  approverPhone?: string;

  /** Verbatim request. Kept for audit; never re-parsed for decisions. */
  rawRequest: string;
  purpose: string;
  amountCents: Cents;
  currency: 'USD';
  seats?: number;

  scope: MandateScope;

  /** Deterministic engine's verdict. */
  policyDecision?: string;
  policyReasons: string[];
  requiresHumanApproval: boolean;

  prava: PravaBinding;

  /** Result of the merchant interaction. */
  outcome?: {
    status: string;
    gatewayMessage?: string;
    completedAt?: string;
    amountCapturedCents?: Cents;
  };

  evidence?: TransactionEvidence;

  createdAt: string;
  updatedAt: string;
  authorizedAt?: string;
  authorizedBy?: string;

  audit: AuditEntry[];
  /** Everything the agent said to a human about this mandate. */
  messages: MessageRecord[];
  /** Guards against duplicate webhook deliveries kicking off two checkouts. */
  executionLockedAt?: string;
}

export interface CreateMandateInput {
  requesterPhone: string;
  requesterName?: string;
  approverPhone?: string;
  rawRequest: string;
  purpose: string;
  amountCents: Cents;
  seats?: number;
  scope: Omit<MandateScope, 'usesConsumed'>;
}

export function createMandate(input: CreateMandateInput): Mandate {
  const now = new Date().toISOString();
  return {
    id: `mdt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    state: MandateState.DRAFT,
    requesterPhone: input.requesterPhone,
    requesterName: input.requesterName,
    approverPhone: input.approverPhone,
    rawRequest: input.rawRequest,
    purpose: input.purpose,
    amountCents: input.amountCents,
    currency: 'USD',
    seats: input.seats,
    scope: { ...input.scope, usesConsumed: 0 },
    policyReasons: [],
    requiresHumanApproval: false,
    prava: {},
    createdAt: now,
    updatedAt: now,
    audit: [{ at: now, actor: 'system', event: 'mandate.created', detail: input.purpose }],
    messages: [],
  };
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly mandateId: string,
    public readonly from: MandateState,
    public readonly to: MandateState,
  ) {
    super(
      `Illegal mandate transition ${from} -> ${to} for ${mandateId}. ` +
        `Allowed from ${from}: ${allowedTransitions(from).join(', ') || '(none, terminal)'}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Advance a mandate. Mutates and returns the same object so callers cannot
 * accidentally keep a stale copy around and write it back later.
 */
export function transition(
  mandate: Mandate,
  to: MandateState,
  actor: string,
  detail?: string,
): Mandate {
  if (!canTransition(mandate.state, to)) {
    throw new IllegalTransitionError(mandate.id, mandate.state, to);
  }
  const from = mandate.state;
  const now = new Date().toISOString();
  mandate.state = to;
  mandate.updatedAt = now;
  mandate.audit.push({ at: now, actor, event: `mandate.${to.toLowerCase()}`, detail, from, to });
  return mandate;
}

/**
 * Record an outbound message on the mandate.
 *
 * Same push-and-touch pattern as appendAudit. Deliberately does not fail if the
 * send itself failed — a message we tried to send is still part of the story,
 * and the audit trail separately records delivery success.
 */
export function recordMessage(mandate: Mandate, to: string, kind: string, body: string): Mandate {
  const now = new Date().toISOString();
  mandate.messages.push({ at: now, direction: 'outbound', to, kind, body });
  mandate.updatedAt = now;
  return mandate;
}

export function appendAudit(mandate: Mandate, actor: string, event: string, detail?: string): Mandate {
  const now = new Date().toISOString();
  mandate.audit.push({ at: now, actor, event, detail });
  mandate.updatedAt = now;
  return mandate;
}

export function isExpired(mandate: Mandate, now: Date = new Date()): boolean {
  return new Date(mandate.scope.expiresAt).getTime() <= now.getTime();
}

export function remainingCapCents(mandate: Mandate): Cents {
  const spent = mandate.outcome?.amountCapturedCents ?? 0;
  return Math.max(0, mandate.scope.totalCapCents - spent);
}

/**
 * The shape the dashboard and API expose.
 *
 * `messages` is included on purpose, unlike prava.authorizationUrl: the
 * transcript is the point of the detail view, and it is already scrubbed.
 * The authorization URL is a bearer capability and stays server-side.
 */
export function toPublicMandate(mandate: Mandate) {
  const { prava, ...rest } = mandate;
  return {
    ...rest,
    // Records written before this field existed load without it.
    messages: mandate.messages ?? [],
    prava: {
      sessionId: prava.sessionId,
      orderId: prava.orderId,
      pravaMandateId: prava.pravaMandateId,
      pravaMandateStatus: prava.pravaMandateStatus,
      transactionId: prava.transactionId,
      txnRefId: prava.txnRefId,
      sessionReportedStatus: prava.sessionReportedStatus,
      cardLast4: prava.cardLast4,
      reportedStatus: prava.reportedStatus,
      visaConfirmation: prava.visaConfirmation,
      hasAuthorizationUrl: Boolean(prava.authorizationUrl),
    },
  };
}
