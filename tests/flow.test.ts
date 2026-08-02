import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the browser so no Stagehand session is opened during tests. The mock is
// declared before the orchestrator is imported so the module graph picks it up.
const checkoutCalls: string[] = [];
vi.mock('../src/services/checkout/browserAgent.js', () => ({
  executeCheckout: vi.fn(async ({ mandate }: any) => {
    checkoutCalls.push(mandate.id);
    return {
      status: 'COMPLETED',
      gatewayMessage: 'Thank you for your order. Order 10023.',
      steps: [{ step: 'submit payment', ok: true, ms: 120 }],
      durationMs: 1200,
      screenshots: [],
    };
  }),
}));

/**
 * Stand in for the model with the deterministic regex parser, but at the
 * confidence a real extraction would report.
 *
 * Without this the suite would only ever exercise the low-confidence path,
 * because the offline fallback caps confidence below the auto-approve
 * threshold on purpose. That safeguard is asserted directly in
 * extractor.test.ts; here we want the parse to be a non-variable so the
 * orchestrator's own behaviour is what is under test.
 */
const parser = vi.hoisted(() => ({ confidence: 0.95 }));
vi.mock('../src/services/policy/extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/policy/extractor.js')>();
  return {
    ...actual,
    extractExpense: vi.fn(async (text: string) => ({
      ...actual.heuristicExtraction(text),
      confidence: parser.confidence,
      source: 'llm' as const,
    })),
  };
});

import { MandateState } from '../src/domain/mandate.js';
import { MandateOrchestrator } from '../src/orchestrator/mandateOrchestrator.js';
import { setPravaClient, PravaClient } from '../src/services/prava/client.js';
import { setLinqClient, LinqClient } from '../src/services/linq/client.js';
import { InMemoryMandateRepository } from '../src/store/memory.js';

/** Records every outbound message so we can assert on what the human is told. */
class FakeLinq extends LinqClient {
  sent: Array<{ to: string; text: string }> = [];
  override async send(to: string, text: string) {
    this.sent.push({ to, text });
    return { ok: true, detail: 'test' };
  }
}

/**
 * Deterministic stand-in for Prava's mandate API. Counts calls so we can assert
 * that approval mints credentials exactly once and that every charge is settled.
 */
class FakePrava extends PravaClient {
  sessions = 0;
  charges = 0;
  reports: Array<{ pravaMandateId: string; txnId: string; status: string }> = [];
  revocations: string[] = [];

  override async createMandateSession(mandate: any) {
    this.sessions += 1;
    return {
      sessionId: `sess_${mandate.id}`,
      approvalUrl: '',
      orderId: `ord_${mandate.id}`,
      authorizeOnly: true,
      degraded: false,
    };
  }

  override async findMandateForOrder(orderId?: string) {
    return { id: `pmdt_${orderId ?? 'x'}`, status: 'active', raw: {} };
  }

  override async chargeMandate(pravaMandateId: string, mandate: any) {
    this.charges += 1;
    return {
      ok: true,
      pravaMandateId,
      transactionId: `txn_${mandate.id}`,
      credentials: { token: '4111111111111111', dynamicCvv: '797', expiryMonth: '12', expiryYear: '2030' },
      detail: 'credentials minted',
    };
  }

  override async reportCharge(pravaMandateId: string, txnId: string, outcome: any) {
    const status = outcome.approved ? 'APPROVED' : 'DECLINED';
    this.reports.push({ pravaMandateId, txnId, status });
    return {
      ok: true,
      detail: 'completed',
      request: { txn_status: status as 'APPROVED' | 'DECLINED', txn_type: 'PURCHASE' as const },
      response: {
        mandateId: pravaMandateId,
        transactionId: txnId,
        status: 'completed',
        mandateStatus: outcome.approved ? 'consumed' : 'active',
        visaConfirmation: 'SUCCESS' as const,
      },
    };
  }

  override async getPaymentResult(sessionId: string) {
    return { ok: true, detail: 'completed', status: 'completed', txnRefId: `ref_${sessionId}` };
  }

  override async reportSessionStatus(sessionId: string, outcome: any) {
    return {
      ok: true,
      detail: 'session reported',
      request: { txn_ref_id: outcome.txnRefId ?? `ref_${sessionId}`, txn_status: outcome.approved ? 'APPROVED' : 'DECLINED' },
    };
  }

  override async revoke(mandate: any) {
    this.revocations.push(mandate.id);
    return { ok: true, detail: 'mandate cancelled; session revoked' };
  }
}

const REQUESTER = '+15550100200';
const settle = () => new Promise((r) => setTimeout(r, 30));

let repo: InMemoryMandateRepository;
let orch: MandateOrchestrator;
let linq: FakeLinq;
let prava: FakePrava;

beforeEach(() => {
  checkoutCalls.length = 0;
  parser.confidence = 0.95;
  repo = new InMemoryMandateRepository();
  orch = new MandateOrchestrator(repo);
  linq = new FakeLinq('test-token');
  prava = new FakePrava('test-key');
  setLinqClient(linq);
  setPravaClient(prava);
});

describe('the authorization gate', () => {
  it('does NOT touch the merchant while a mandate awaits approval', async () => {
    // The regression this whole refactor exists for: the previous
    // implementation started checkout in the same call that sent the link.
    const result = await orch.handleInboundMessage(
      REQUESTER,
      'We need a $45 monthly subscription to Figma for 2 designers',
    );
    await settle();

    expect(result.mandate?.state).toBe(MandateState.PENDING_APPROVAL);
    expect(checkoutCalls).toHaveLength(0);
    expect(prava.charges).toBe(0); // no credential minted either
  });

  it('runs checkout exactly once, only after authorize()', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await orch.authorize(mandate!.id, 'approver (passkey)');
    await settle();

    expect(checkoutCalls).toEqual([mandate!.id]);
    const final = await orch.get(mandate!.id);
    expect(final.state).toBe(MandateState.COMPLETED);
    expect(final.authorizedBy).toBe('approver (passkey)');
  });

  it('is idempotent when the approval link is tapped twice', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await Promise.all([
      orch.authorize(mandate!.id, 'approver (passkey)'),
      orch.authorize(mandate!.id, 'approver (passkey)'),
    ]);
    await settle();

    expect(checkoutCalls).toHaveLength(1);
    expect(prava.charges).toBe(1);
  });

  it('refuses to execute a mandate that was never authorized', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    const outcome = await orch.provisionAndExecute(mandate!.id);

    expect(outcome).toBeNull();
    expect(checkoutCalls).toHaveLength(0);
  });

  it('refuses to authorize a mandate that already expired', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await repo.withLock(mandate!.id, async (m) => {
      m.scope.expiresAt = new Date(Date.now() - 1000).toISOString();
    });

    await expect(orch.authorize(mandate!.id, 'late approver')).rejects.toThrow(/expired/i);
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('auto-approval below the unattended limit', () => {
  it('buys without a human and reports the result to Prava', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();

    const final = await orch.get(mandate!.id);
    expect(final.policyDecision).toBe('auto_approve');
    expect(final.state).toBe(MandateState.COMPLETED);
    expect(checkoutCalls).toEqual([mandate!.id]);
    expect(prava.reports.at(-1)?.status).toBe('APPROVED');
  });
});

describe('rejection', () => {
  it('refuses an out-of-policy category without creating a session', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Team dinner at Olive, $80');
    await settle();

    expect(mandate?.state).toBe(MandateState.REJECTED);
    expect(prava.sessions).toBe(0);
    expect(prava.charges).toBe(0);
    expect(linq.sent.at(-1)?.text).toMatch(/not approved/i);
  });

  it('tells the requester why, in the words of the policy', async () => {
    await orch.handleInboundMessage(REQUESTER, 'MacBook Pro from Apple for $2400');
    await settle();
    const message = linq.sent.map((s) => s.text).join('\n');
    expect(message).toMatch(/ceiling|procurement/i);
  });
});

describe('revocation', () => {
  it('kills the credential upstream and reports it', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await orch.revoke(mandate!.id, 'Finance Approver');

    const final = await orch.get(mandate!.id);
    expect(final.state).toBe(MandateState.REVOKED);
    expect(prava.revocations).toContain(mandate!.id);
    expect((await orch.get(mandate!.id)).prava.pravaMandateStatus).not.toBe('active');
  });

  it('will not revoke something already settled', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();
    await expect(orch.revoke(mandate!.id, 'Finance Approver')).rejects.toThrow(/already/i);
  });
});

describe('budget accounting across requests', () => {
  it('counts committed spend so the fourth request is refused', async () => {
    // Monthly budget defaults to $500; four $90 approvals with a $100 ceiling
    // should still fit, so push past it deliberately.
    for (let i = 0; i < 6; i++) {
      const { mandate } = await orch.handleInboundMessage(REQUESTER, 'GitHub Team seats for $90');
      if (mandate?.state === MandateState.PENDING_APPROVAL) {
        await orch.authorize(mandate.id, 'approver');
      }
      await settle();
    }
    const last = await orch.handleInboundMessage(REQUESTER, 'GitHub Team seats for $90');
    await settle();
    expect(last.mandate?.state).toBe(MandateState.REJECTED);
    expect(last.mandate?.policyReasons.join(' ')).toMatch(/budget/i);
  });
});

describe('weak parses', () => {
  it('escalates to a human instead of spending on a low-confidence parse', async () => {
    parser.confidence = 0.3;
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();

    expect(mandate?.state).toBe(MandateState.PENDING_APPROVAL);
    expect(mandate?.policyReasons.join(' ')).toMatch(/confidence/i);
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('conversational surfaces', () => {
  it('answers help without creating a mandate', async () => {
    const result = await orch.handleInboundMessage(REQUESTER, 'help');
    expect(result.kind).toBe('help');
    expect(await orch.list()).toHaveLength(0);
  });

  it('asks a question rather than guessing when details are missing', async () => {
    const result = await orch.handleInboundMessage(REQUESTER, 'can we get some design software');
    expect(['clarify', 'mandate']).toContain(result.kind);
    if (result.kind === 'mandate') {
      expect(result.mandate?.state).toBe(MandateState.REJECTED);
    }
  });
});

describe('expiry sweep', () => {
  it('closes stale pending mandates and tells the requester', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await repo.withLock(mandate!.id, async (m) => {
      m.scope.expiresAt = new Date(Date.now() - 1000).toISOString();
    });

    expect(await orch.expireStale()).toBe(1);
    expect((await orch.get(mandate!.id)).state).toBe(MandateState.EXPIRED);
    expect(linq.sent.at(-1)?.text).toMatch(/expired/i);
  });
});

describe('transaction evidence', () => {
  it('records what the gateway said and what we told Prava', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();

    const final = await orch.get(mandate!.id);
    expect(final.evidence).toBeDefined();
    expect(final.evidence?.gatewayMessage).toMatch(/thank you for your order/i);
    expect(final.evidence?.reportRequest?.txn_status).toBe('APPROVED');
    expect(final.evidence?.reportResponse?.visaConfirmation).toBe('SUCCESS');
    expect(final.prava.reportedStatus).toBe('APPROVED');
  });

  it('settles every charge it mints, so nothing is left awaiting a result', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();
    expect(prava.charges).toBe(prava.reports.length);
    expect(prava.reports[0]?.txnId).toBe(`txn_${mandate!.id}`);
  });
});

describe('message transcript', () => {
  it('keeps the exact text of every message it sent', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    const final = await orch.get(mandate!.id);

    expect(final.messages.length).toBeGreaterThan(0);
    const approval = final.messages.find((m) => m.kind === 'approval_request');
    expect(approval).toBeDefined();
    expect(approval?.body).toBe(linq.sent.find((s) => s.text.includes('Approval needed'))?.text);
    expect(approval?.direction).toBe('outbound');
  });

  it('records the receipt after the merchant responds', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();
    const final = await orch.get(mandate!.id);
    expect(final.messages.map((m) => m.kind)).toContain('receipt');
  });

  it('never lets a network token into the transcript', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();
    const final = await orch.get(mandate!.id);
    expect(JSON.stringify(final.messages)).not.toContain('4111111111111111');
  });
});

describe('decline with a reason', () => {
  it('passes the approver words through to the requester verbatim', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await orch.reject(mandate!.id, 'Finance Approver', 'declined at approval screen', 'we already have seats');

    const final = await orch.get(mandate!.id);
    expect(final.state).toBe(MandateState.REJECTED);
    expect(final.policyReasons.join(' ')).toContain('we already have seats');
    expect(final.messages.at(-1)?.body).toContain('we already have seats');
  });

  it('still works when no reason is given', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await orch.reject(mandate!.id, 'Finance Approver');
    expect((await orch.get(mandate!.id)).policyReasons.join(' ')).toMatch(/declined this request/i);
  });
});

describe('a revoked or spent mandate cannot be charged again', () => {
  it('blocks a second charge after revocation', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Figma $45/mo for 2 designers');
    await orch.revoke(mandate!.id, 'Finance Approver');
    const chargesBefore = prava.charges;

    // Exactly what the dashboard's "simulate rogue re-charge" button calls.
    const result = await orch.provisionAndExecute(mandate!.id);

    expect(result).toBeNull();
    expect(prava.charges).toBe(chargesBefore);
    expect(checkoutCalls).toHaveLength(0);
    expect((await orch.get(mandate!.id)).state).toBe(MandateState.REVOKED);
  });

  it('blocks a second charge after the first one settled', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();
    expect(checkoutCalls).toHaveLength(1);

    const result = await orch.provisionAndExecute(mandate!.id);

    expect(result).toBeNull();
    expect(checkoutCalls).toHaveLength(1);
    expect(prava.charges).toBe(1);
  });
});

describe('card handling', () => {
  it('persists only the last four digits, never the number', async () => {
    const { mandate } = await orch.handleInboundMessage(REQUESTER, 'Top up OpenAI credits by $20');
    await settle();

    const final = await orch.get(mandate!.id);
    expect(final.prava.cardLast4).toBe('1111');
    expect(final.prava.transactionId).toBe(`txn_${mandate!.id}`);
    expect(JSON.stringify(final)).not.toContain('4111111111111111');
  });
});
