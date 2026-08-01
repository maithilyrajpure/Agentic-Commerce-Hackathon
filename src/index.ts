import { capabilities, env } from './config/env.js';
import { spendPolicy } from './config/policy.js';
import { describeMode, resolveMerchant } from './config/merchants.js';
import { formatUsd } from './domain/money.js';
import { logger } from './lib/logger.js';
import { orchestrator } from './orchestrator/mandateOrchestrator.js';
import { createApp } from './app.js';

/**
 * Process entry point: boot, report what is actually wired, start the expiry
 * sweeper, and shut down cleanly.
 */
async function main(): Promise<void> {
  const app = createApp();
  const orch = await orchestrator();

  const server = app.listen(env.PORT, () => {
    const missing = Object.entries(capabilities)
      .filter(([, on]) => !on)
      .map(([name]) => name);

    logger.info(
      {
        port: env.PORT,
        baseUrl: env.PUBLIC_BASE_URL,
        store: env.STORE_DRIVER,
        pravaEnv: env.PRAVA_ENV,
        checkoutMode: env.CHECKOUT_MODE,
        policy: spendPolicy.version,
        integrations: capabilities,
      },
      'mandate manager listening',
    );

    // Loud, once, at boot: a demo that silently ran in fallback mode is worse
    // than one that refused to start.
    if (missing.length) {
      logger.warn(
        { missing },
        `running with ${missing.length} integration(s) unconfigured — these paths will simulate rather than transact`,
      );
    }

    console.log(
      [
        '',
        `  ${env.ORG_NAME} · agentic mandate manager`,
        `  dashboard   ${env.PUBLIC_BASE_URL}/dashboard`,
        `  webhook     POST ${env.PUBLIC_BASE_URL}/webhooks/linq`,
        `  simulate    POST ${env.PUBLIC_BASE_URL}/api/simulate/message  {"from":"+1...","text":"..."}`,
        '',
        `  unattended up to ${formatUsd(spendPolicy.autoApproveCents)} · passkey to ${formatUsd(spendPolicy.hardCeilingCents)} · ${formatUsd(spendPolicy.monthlyBudgetPerRequesterCents)}/month each`,
        `  ${describeMode(env.CHECKOUT_MODE, resolveMerchant({ mode: env.CHECKOUT_MODE, merchantId: env.MERCHANT_ID, devStoreUrl: env.DEV_STORE_URL, devStoreName: env.DEV_STORE_NAME }))}`,
        '',
      ].join('\n'),
    );
  });

  // Sweep expired mandates so nothing sits pending forever holding budget.
  const sweeper = setInterval(() => {
    void orch.expireStale().catch((err) => logger.error({ err: err.message }, 'expiry sweep failed'));
  }, 60_000);
  sweeper.unref();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: (reason as Error)?.message ?? reason }, 'unhandled rejection');
  });
}

main().catch((error) => {
  logger.fatal({ err: (error as Error).message }, 'failed to start');
  console.error(error);
  process.exit(1);
});
