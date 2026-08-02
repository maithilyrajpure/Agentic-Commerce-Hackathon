import { Router } from 'express';
import { spendPolicy } from '../../config/policy.js';
import { explainPolicy } from '../../services/policy/engine.js';
import { env } from '../../config/env.js';
import { toPublicMandate } from '../../domain/mandate.js';
import { orchestrator } from '../../orchestrator/mandateOrchestrator.js';
import { apiLimiter, asyncRoute } from '../middleware.js';

export const mandateRouter = Router();

/**
 * Read/control API behind the dashboard.
 *
 * Every response goes through toPublicMandate, which strips the Prava
 * authorization URL and any card material. The dashboard shows the last four
 * digits and nothing else, because a UI that can display a PAN is a UI that can
 * leak one over a shared screen.
 */

mandateRouter.get(
  '/api/mandates',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const orch = await orchestrator();
    const mandates = await orch.list(limit);
    res.json({ mandates: mandates.map(toPublicMandate) });
  }),
);

mandateRouter.get(
  '/api/mandates/:id',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const orch = await orchestrator();
    const mandate = await orch.get(req.params.id ?? '');
    res.json({ mandate: toPublicMandate(mandate) });
  }),
);

/** Withdraw authority. Cancels the session and kills the card upstream. */
mandateRouter.post(
  '/api/mandates/:id/revoke',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const actor = String(req.body?.actor ?? env.APPROVER_NAME);
    const reason = String(req.body?.reason ?? 'revoked from dashboard');
    const orch = await orchestrator();
    const mandate = await orch.revoke(req.params.id ?? '', actor, reason);
    res.json({ mandate: toPublicMandate(mandate) });
  }),
);

/** Approve from the dashboard rather than the messaged link. */
mandateRouter.post(
  '/api/mandates/:id/approve',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const actor = String(req.body?.actor ?? `${env.APPROVER_NAME} (dashboard)`);
    const orch = await orchestrator();
    const mandate = await orch.authorize(req.params.id ?? '', actor);
    res.json({ mandate: toPublicMandate(mandate) });
  }),
);

mandateRouter.post(
  '/api/mandates/:id/decline',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const actor = String(req.body?.actor ?? `${env.APPROVER_NAME} (dashboard)`);
    const orch = await orchestrator();
    const mandate = await orch.reject(req.params.id ?? '', actor, 'declined from dashboard');
    res.json({ mandate: toPublicMandate(mandate) });
  }),
);

/**
 * Demo route: attempt a second charge against a mandate.
 *
 * This is the rogue-recurring-charge scenario the product exists to stop, and
 * it is worth being able to run on camera. It deliberately calls the SAME
 * provisionAndExecute() the real flow uses rather than a mock, so what it
 * proves is the actual guardrail: the state machine refuses to re-enter
 * PROVISIONED from a terminal state, and Prava has already consumed or
 * cancelled the mandate upstream.
 *
 * A null return means the attempt was blocked before any credential existed.
 */
mandateRouter.post(
  '/api/mandates/:id/simulate-second-charge',
  apiLimiter,
  asyncRoute(async (req, res) => {
    const orch = await orchestrator();
    const before = await orch.get(req.params.id ?? '');

    const result = await orch.provisionAndExecute(before.id);
    const after = await orch.get(before.id);

    if (result === null) {
      res.json({
        blocked: true,
        reason:
          `Refused. The mandate is ${before.state.toLowerCase().replace(/_/g, ' ')}, and a charge ` +
          'can only start from AUTHORIZED. No credential was requested and nothing reached the merchant.',
        stateBefore: before.state,
        stateAfter: after.state,
        mandate: toPublicMandate(after),
      });
      return;
    }

    res.json({
      blocked: false,
      reason: `A second charge ran and resolved ${result.status}.`,
      stateBefore: before.state,
      stateAfter: after.state,
      mandate: toPublicMandate(after),
    });
  }),
);

mandateRouter.get(
  '/api/summary',
  apiLimiter,
  asyncRoute(async (_req, res) => {
    const orch = await orchestrator();
    res.json({ summary: await orch.summary(), org: env.ORG_NAME, approver: env.APPROVER_NAME });
  }),
);

/** The policy, published. A control people cannot read is not a control. */
mandateRouter.get('/api/policy', apiLimiter, (_req, res) => {
  res.json({
    version: spendPolicy.version,
    summary: explainPolicy(),
    autoApproveCents: spendPolicy.autoApproveCents,
    hardCeilingCents: spendPolicy.hardCeilingCents,
    monthlyBudgetPerRequesterCents: spendPolicy.monthlyBudgetPerRequesterCents,
    mandateTtlMinutes: spendPolicy.mandateTtlMinutes,
    categories: spendPolicy.categories,
    knownMerchants: spendPolicy.knownMerchants,
  });
});
