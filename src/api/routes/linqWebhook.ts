import { Router } from 'express';
import { env } from '../../config/env.js';
import { verifyWebhookSignature } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { scrubDeep } from '../../lib/redact.js';
import { parseInboundMessage } from '../../services/linq/client.js';
import { orchestrator } from '../../orchestrator/mandateOrchestrator.js';
import { webhookLimiter } from '../middleware.js';

export const linqRouter = Router();

/**
 * Inbound iMessage.
 *
 * Two rules for webhook endpoints:
 *
 *   Answer fast. Providers retry anything that is slow or non-2xx, and a
 *   retried purchase request is a duplicate purchase. We acknowledge before
 *   doing any work.
 *
 *   Answer 200 even for payloads we ignore. A 4xx on an unrecognized event
 *   type makes the provider redeliver it forever.
 */
linqRouter.get('/webhooks/linq', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'linq-webhook' });
});

linqRouter.post('/webhooks/linq', webhookLimiter, (req, res) => {
  const log = logger.child({ correlationId: req.correlationId, route: 'linq-webhook' });

  if (env.LINQ_WEBHOOK_SECRET) {
    const signature = req.header('x-linq-signature') ?? req.header('x-signature') ?? req.header('x-hub-signature-256');
    if (!verifyWebhookSignature(req.rawBody ?? '', signature, env.LINQ_WEBHOOK_SECRET)) {
      log.warn('rejected linq webhook with bad signature');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  log.info({ body: scrubDeep(req.body) }, 'linq webhook received');
  const message = parseInboundMessage(req.body);

  // Acknowledge first, work second.
  res.status(200).json({ status: 'accepted', correlationId: req.correlationId });

  if (!message) {
    log.info({ body: scrubDeep(req.body) }, 'webhook payload had no usable message');
    return;
  }
  if (message.eventType && !/(message|chat)\.(created|received|inbound)/i.test(message.eventType)) {
    log.info({ eventType: message.eventType }, 'ignoring non-inbound event');
    return;
  }

  void (async () => {
    try {
      const orch = await orchestrator();
      const result = await orch.handleInboundMessage(message.fromPhone, message.text);
      log.info({ kind: result.kind, mandateId: result.mandate?.id }, 'inbound message handled');
    } catch (error) {
      log.error({ err: (error as Error).message }, 'inbound message handling failed');
    }
  })();
});

/**
 * Test seam for the demo and for judges without a Linq number: same code path
 * as the webhook, but synchronous so the response carries the decision.
 */
linqRouter.post('/api/simulate/message', webhookLimiter, (req, res, next) => {
  const { from, text } = (req.body ?? {}) as { from?: string; text?: string };
  if (!from || !text) {
    res.status(400).json({ error: 'validation_error', message: 'Provide { "from": "+1...", "text": "..." }' });
    return;
  }

  void (async () => {
    try {
      const orch = await orchestrator();
      const result = await orch.handleInboundMessage(from, text);
      res.json({
        kind: result.kind,
        reply: result.reply,
        // Enough for the dashboard to show what the agent understood before
        // anything was decided. Deliberately a projection, not the full
        // mandate: this endpoint is a test seam, not a data API.
        mandate: result.mandate
          ? {
              id: result.mandate.id,
              state: result.mandate.state,
              merchant: result.mandate.scope.merchant,
              amountCents: result.mandate.amountCents,
              recurrence: result.mandate.scope.recurrence,
              category: result.mandate.scope.category,
              seats: result.mandate.seats,
              purpose: result.mandate.purpose,
              policyDecision: result.mandate.policyDecision,
              policyReasons: result.mandate.policyReasons,
            }
          : undefined,
      });
    } catch (error) {
      next(error);
    }
  })();
});
