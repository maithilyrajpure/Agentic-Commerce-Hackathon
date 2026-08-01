import { env } from '../../config/env.js';
import { spendPolicy } from '../../config/policy.js';
import { formatUsd } from '../../domain/money.js';
import type { Mandate } from '../../domain/mandate.js';
import type { PolicyDecision } from '../policy/engine.js';

/**
 * Message copy.
 *
 * These are read on a phone, one thumb, mid-task. So: the decision comes first,
 * the reason comes second, and the action comes last. No preamble, no emoji
 * garnish beyond one status glyph, and never a wall of labelled fields where a
 * sentence would do.
 *
 * The approver message is the one that matters most. It has to let someone
 * approve or refuse company spend correctly in about eight seconds, which means
 * it must state what is being bought, for whom, why it needs a human, and what
 * the money can and cannot do once released.
 */

const line = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join('\n');

function expiryPhrase(mandate: Mandate): string {
  const minutes = Math.max(1, Math.round((new Date(mandate.scope.expiresAt).getTime() - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} min`;
}

function scopeSummary(mandate: Mandate): string {
  const uses = mandate.scope.maxUses === 1 ? 'single use' : `${mandate.scope.maxUses} uses`;
  return `Locked to ${mandate.scope.merchant} · ${formatUsd(mandate.scope.perTransactionCapCents)} cap · ${uses} · expires in ${expiryPhrase(mandate)}`;
}

/** Sent to the requester when the deterministic engine refuses. */
export function rejectionMessage(mandate: Mandate, decision: PolicyDecision): string {
  return line(
    `✕ Not approved — ${mandate.scope.merchant || 'this request'}${mandate.amountCents ? `, ${formatUsd(mandate.amountCents)}` : ''}`,
    '',
    decision.reasons.map((r) => `· ${r}`).join('\n'),
    '',
    `Policy ${spendPolicy.version}. Reply with corrected details, or raise it with ${env.APPROVER_NAME} if you think this is wrong.`,
  );
}

/** Sent to the requester when the agent proceeds without a human. */
export function autoApprovedMessage(mandate: Mandate): string {
  return line(
    `✓ Approved — ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    '',
    `Under the ${formatUsd(spendPolicy.autoApproveCents)} unattended limit, so no approval needed.`,
    scopeSummary(mandate),
    '',
    'Buying it now. Receipt to follow.',
  );
}

/** Sent to the requester while they wait on their approver. */
export function pendingApprovalMessage(mandate: Mandate, decision: PolicyDecision): string {
  return line(
    `⧗ Sent to ${env.APPROVER_NAME} — ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    '',
    decision.reasons.map((r) => `· ${r}`).join('\n'),
    '',
    `The approval link expires in ${expiryPhrase(mandate)}. You'll get a message either way.`,
  );
}

/**
 * Sent to the approver. This is the passkey prompt.
 *
 * The scope line is the important one: it tells the approver that saying yes
 * releases a credential that cannot be used for more, elsewhere, or again.
 * That is the difference between approving a purchase and handing over a card.
 */
export function approvalRequestMessage(mandate: Mandate, decision: PolicyDecision, approveUrl: string): string {
  const who = mandate.requesterName ?? mandate.requesterPhone;
  return line(
    `Approval needed — ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    '',
    `${who} wants: ${mandate.purpose}`,
    mandate.seats ? `Seats: ${mandate.seats}` : undefined,
    mandate.scope.recurrence !== 'one_time' ? `Billing: ${mandate.scope.recurrence}` : undefined,
    '',
    'Why this needs you:',
    decision.reasons.map((r) => `· ${r}`).join('\n'),
    decision.warnings.length ? '' : undefined,
    decision.warnings.length ? decision.warnings.map((w) => `! ${w}`).join('\n') : undefined,
    '',
    `Approving releases one card: ${scopeSummary(mandate)}`,
    '',
    'Approve with your passkey:',
    approveUrl,
  );
}

/** Final receipt after the merchant responds. */
export function receiptMessage(mandate: Mandate): string {
  const outcome = mandate.outcome;
  const succeeded = mandate.state === 'COMPLETED';
  const glyph = succeeded ? '✓' : mandate.state === 'DECLINED' ? '✕' : '!';

  const headline = succeeded
    ? `${glyph} Paid — ${formatUsd(mandate.outcome?.amountCapturedCents ?? mandate.amountCents)} at ${mandate.scope.merchant}`
    : mandate.state === 'DECLINED'
      ? `${glyph} Declined at ${mandate.scope.merchant} — no money moved`
      : `${glyph} Couldn't complete checkout at ${mandate.scope.merchant} — no money moved`;

  return line(
    headline,
    '',
    outcome?.gatewayMessage ? `Gateway: ${outcome.gatewayMessage}` : undefined,
    mandate.prava.cardLast4 ? `Card ···${mandate.prava.cardLast4} · ${mandate.scope.merchant} only` : undefined,
    `Mandate ${mandate.id}`,
    '',
    succeeded
      ? 'The card is now spent and cannot be reused.'
      : 'The card was cancelled. Nothing can be charged against this mandate.',
    mandate.prava.reportedStatus ? `Reported to Prava as ${mandate.prava.reportedStatus}.` : undefined,
  );
}

/** Sent when the mandate times out before anyone approved. */
export function expiredMessage(mandate: Mandate): string {
  return line(
    `⧗ Expired — ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    '',
    `Nobody approved it within ${spendPolicy.mandateTtlMinutes} minutes, so the request closed itself and no credential was issued.`,
    '',
    'Send it again if you still need it.',
  );
}

export function revokedMessage(mandate: Mandate, actor: string): string {
  return line(
    `✕ Revoked — ${formatUsd(mandate.amountCents)} at ${mandate.scope.merchant}`,
    '',
    `${actor} withdrew this mandate. The card is dead and cannot be charged.`,
    `Mandate ${mandate.id}`,
  );
}

/** Reply when the message is not a purchase request at all. */
export function clarificationMessage(question: string): string {
  return line(
    question || 'What are you buying, from whom, and for how much?',
    '',
    `Example: "Figma, $45/mo for 2 designers"`,
  );
}

/** Reply to "help", "policy", "what can I buy". */
export function helpMessage(): string {
  const allowed = spendPolicy.categories.filter((c) => c.allowed).map((c) => c.label.toLowerCase());
  return line(
    `${env.ORG_NAME} purchasing agent`,
    '',
    'Tell me what you need and I handle the rest. For example:',
    '"Figma, $45/mo for 2 designers"',
    '"Top up OpenAI credits by $20"',
    '',
    `I buy: ${allowed.join(', ')}.`,
    `Up to ${formatUsd(spendPolicy.autoApproveCents)} I go ahead. Above that, ${env.APPROVER_NAME} approves with a passkey.`,
    `Hard stop at ${formatUsd(spendPolicy.hardCeilingCents)} and ${formatUsd(spendPolicy.monthlyBudgetPerRequesterCents)} a month each.`,
    '',
    'Say "status" to see what you have open.',
  );
}

/** Reply to "status". */
export function statusMessage(mandates: Mandate[]): string {
  if (mandates.length === 0) {
    return line('Nothing open right now.', '', 'Send me a request when you need something.');
  }
  const rows = mandates
    .slice(0, 8)
    .map((m) => `· ${formatUsd(m.amountCents)} ${m.scope.merchant} — ${m.state.toLowerCase().replace(/_/g, ' ')}`);
  return line(`${mandates.length} open:`, '', rows.join('\n'));
}
