import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createMandate,
  IllegalTransitionError,
  isTerminal,
  MandateState,
  toPublicMandate,
  transition,
} from '../src/domain/mandate.js';

const build = () =>
  createMandate({
    requesterPhone: '+15550100200',
    rawRequest: 'Figma $45/mo for 2 designers',
    purpose: '2 designer seats',
    amountCents: 4500,
    scope: {
      merchant: 'Figma',
      perTransactionCapCents: 4500,
      totalCapCents: 4500,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      recurrence: 'monthly',
      category: 'software_subscription',
    },
  });

describe('mandate state machine', () => {
  it('will not let a pending mandate reach a merchant', () => {
    // This is the defect the state machine exists to make unrepresentable:
    // the previous implementation started checkout while awaiting approval.
    expect(canTransition(MandateState.PENDING_APPROVAL, MandateState.EXECUTING)).toBe(false);
    expect(canTransition(MandateState.PENDING_APPROVAL, MandateState.PROVISIONED)).toBe(false);
    expect(canTransition(MandateState.PENDING_APPROVAL, MandateState.COMPLETED)).toBe(false);
  });

  it('requires authorization before provisioning and provisioning before execution', () => {
    expect(canTransition(MandateState.AUTHORIZED, MandateState.PROVISIONED)).toBe(true);
    expect(canTransition(MandateState.PROVISIONED, MandateState.EXECUTING)).toBe(true);
    expect(canTransition(MandateState.AUTHORIZED, MandateState.EXECUTING)).toBe(false);
    expect(canTransition(MandateState.DRAFT, MandateState.PROVISIONED)).toBe(false);
  });

  it('throws on an illegal transition instead of silently allowing it', () => {
    const m = build();
    expect(() => transition(m, MandateState.COMPLETED, 'test')).toThrow(IllegalTransitionError);
    expect(m.state).toBe(MandateState.DRAFT);
  });

  it('walks the full happy path and records who did what', () => {
    const m = build();
    transition(m, MandateState.PENDING_APPROVAL, 'policy-engine');
    transition(m, MandateState.AUTHORIZED, 'approver (passkey)');
    transition(m, MandateState.PROVISIONED, 'system');
    transition(m, MandateState.EXECUTING, 'browser-agent');
    transition(m, MandateState.COMPLETED, 'browser-agent');

    expect(m.state).toBe(MandateState.COMPLETED);
    expect(isTerminal(m.state)).toBe(true);
    expect(m.audit.map((a) => a.event)).toContain('mandate.authorized');
    expect(m.audit.find((a) => a.to === MandateState.AUTHORIZED)?.actor).toBe('approver (passkey)');
  });

  it('seals terminal states', () => {
    const m = build();
    transition(m, MandateState.REJECTED, 'policy-engine');
    expect(() => transition(m, MandateState.AUTHORIZED, 'attacker')).toThrow(IllegalTransitionError);
  });

  it('allows revocation right up to execution', () => {
    expect(canTransition(MandateState.AUTHORIZED, MandateState.REVOKED)).toBe(true);
    expect(canTransition(MandateState.PROVISIONED, MandateState.REVOKED)).toBe(true);
  });

  it('never exposes the authorization url through the public shape', () => {
    const m = build();
    m.prava = { sessionId: 's_1', pravaMandateId: 'pmdt_1', cardLast4: '2465', authorizationUrl: 'https://secret' };
    const pub = toPublicMandate(m) as Record<string, any>;
    expect(pub.prava.authorizationUrl).toBeUndefined();
    expect(pub.prava.hasAuthorizationUrl).toBe(true);
    expect(pub.prava.cardLast4).toBe('2465');
    expect(JSON.stringify(pub)).not.toContain('https://secret');
  });
});
