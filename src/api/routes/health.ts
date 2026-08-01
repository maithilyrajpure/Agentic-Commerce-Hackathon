import { Router } from 'express';
import { capabilities, env } from '../../config/env.js';
import { spendPolicy } from '../../config/policy.js';
import { asyncRoute } from '../middleware.js';
import { orchestrator } from '../../orchestrator/mandateOrchestrator.js';

export const healthRouter = Router();

/** Liveness. Deliberately cheap: no upstream calls, no store reads. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mandate-manager', timestamp: new Date().toISOString() });
});

/**
 * Readiness. Reports which integrations are actually wired, because "the demo
 * silently ran in fallback mode" is the most expensive failure at a hackathon.
 */
healthRouter.get(
  '/ready',
  asyncRoute(async (_req, res) => {
    const orch = await orchestrator();
    const summary = await orch.summary();
    const degraded = Object.entries(capabilities)
      .filter(([, on]) => !on)
      .map(([name]) => name);

    res.status(degraded.length ? 200 : 200).json({
      status: degraded.length ? 'degraded' : 'ok',
      integrations: capabilities,
      degraded,
      pravaEnv: env.PRAVA_ENV,
      pravaApiBase: env.PRAVA_API_BASE,
      checkoutMode: env.CHECKOUT_MODE,
      merchant: env.CHECKOUT_MODE === 'dev_store' ? env.DEV_STORE_NAME : env.MERCHANT_ID,
      store: env.STORE_DRIVER,
      policyVersion: spendPolicy.version,
      mandates: summary,
      timestamp: new Date().toISOString(),
    });
  }),
);
