import { Router } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../domain/errors.js';
import { verifyGrant, verifyWebhookSignature, verifyApprovalPin } from '../../lib/crypto.js'
import { logger } from '../../lib/logger.js';
import { scrubDeep } from '../../lib/redact.js';
import { orchestrator } from '../../orchestrator/mandateOrchestrator.js';
import { approvalPage, approvedPage, declinedPage, invalidTokenPage } from '../../web/pages.js';
import { asyncRoute, authorizeLimiter, webhookLimiter } from '../middleware.js';

export const authorizeRouter = Router();

/**
 * GET renders. POST decides.
 *
 * This split is the whole security posture of the approval link. A message
 * containing a URL gets fetched by things that are not the approver: iMessage
 * link previews, corporate URL scanners, and anything that indexes a shared
 * thread. If a GET released the credential, the purchase would be approved
 * before a human read the message.
 *
 * So GET is safe and idempotent — it only shows what would happen. The consent
 * is the POST the button issues, which cannot be triggered by a prefetch.
 */
authorizeRouter.get(
  '/authorize/:token',
  authorizeLimiter,
  asyncRoute(async (req, res) => {
    const token = req.params.token ?? '';
    const verification = verifyGrant(token);

    if (!verification.ok) {
      res.status(400).type('html').send(invalidTokenPage(verification.reason));
      return;
    }

    const orch = await orchestrator();
    const mandate = await orch.get(verification.grant.mandateId);

    if (mandate.state !== 'PENDING_APPROVAL') {
      res.status(409).type('html').send(invalidTokenPage('used'));
      return;
    }

    res.type('html').send(approvalPage(mandate, token));
  }),
);

/** The actual authorization. */
authorizeRouter.post(
  '/authorize/:token',
  authorizeLimiter,
  asyncRoute(async (req, res) => {
    const token = req.params.token ?? '';
    const verification = verifyGrant(token);

    if (!verification.ok) {
      res.status(400).type('html').send(invalidTokenPage(verification.reason));
      return;
    }

    const action = (req.body?.action ?? 'approve') as 'approve' | 'decline';
    const orch = await orchestrator();
    const actor = `${env.APPROVER_NAME} (passkey)`;
    const log = logger.child({ correlationId: req.correlationId, mandateId: verification.grant.mandateId });

    try {
      if (action === 'decline') {
        // The approver's own words, capped and passed through verbatim to the
        // requester. Sanitized at render, not here, so the audit trail keeps
        // exactly what was typed.
        const note = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined;
        const mandate = await orch.reject(
          verification.grant.mandateId,
          actor,
          'declined at approval screen',
          note,
        );
        log.info({ hasReason: Boolean(note?.trim()) }, 'mandate declined by approver');
        res.type('html').send(declinedPage(mandate, note));
        return;
      }

      // Fallback second factor. A fingerprint is a local gate the server can't
      // see, so when the approver instead enters the code from their message we
      // verify it here. If a code was submitted it must be correct; if none was
      // (the fingerprint path), the signed token remains the authority.
      const submittedCode = typeof req.body?.code === 'string' ? req.body.code : '';
      if (submittedCode && !verifyApprovalPin(verification.grant.mandateId, submittedCode)) {
        log.warn('approval code mismatch');
        res.status(401).type('html').send(invalidTokenPage('bad_code'));
        return;
      }

      const mandate = await orch.authorize(verification.grant.mandateId, actor);
      log.info('mandate authorized by approver');
      res.type('html').send(approvedPage(mandate));
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        res.status(409).type('html').send(invalidTokenPage('used'));
        return;
      }
      throw error;
    }
  }),
);

/**
 * Redirect target for Prava's hosted passkey flow.
 *
 * Prava sends the user back here after their own authorization UI. We do not
 * trust the query string on its own — a `?status=authorized` parameter is not
 * evidence of anything. The signed token we appended when minting the link is
 * what carries authority, so this route just forwards to the POST-guarded page.
 */
authorizeRouter.get(
  '/authorize/callback',
  authorizeLimiter,
  asyncRoute(async (req, res) => {
    const token = String(req.query.token ?? req.query.grant ?? '');
    if (!token) {
      res.status(400).type('html').send(invalidTokenPage('malformed'));
      return;
    }
    res.redirect(302, `/authorize/${encodeURIComponent(token)}`);
  }),
);

/**
 * Prava's server-to-server webhook.
 *
 * Unlike the browser redirect this is authenticated by HMAC, so it is allowed
 * to move a mandate. When PRAVA_WEBHOOK_SECRET is unset we log and ignore
 * rather than trusting an unsigned body — an unauthenticated endpoint that
 * authorizes spend is a vulnerability, not a convenience.
 */
authorizeRouter.post(
  '/webhooks/prava',
  webhookLimiter,
  asyncRoute(async (req, res) => {
    const log = logger.child({ correlationId: req.correlationId, route: 'prava-webhook' });
    const signature =
      req.header('x-prava-signature') ?? req.header('x-signature') ?? req.header('x-hub-signature-256');

    if (!env.PRAVA_WEBHOOK_SECRET) {
      log.warn('PRAVA_WEBHOOK_SECRET is not set; webhook observed but ignored');
      res.status(202).json({ status: 'ignored', reason: 'webhook secret not configured' });
      return;
    }
    if (!verifyWebhookSignature(req.rawBody ?? '', signature, env.PRAVA_WEBHOOK_SECRET)) {
      log.warn('rejected prava webhook with bad signature');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, any>;
    const sessionId: string | undefined =
      body.session_id ?? body.sessionId ?? body.data?.session_id ?? body.data?.sessionId;
    const status: string = String(body.status ?? body.event ?? body.type ?? '').toLowerCase();

    res.status(200).json({ status: 'accepted' });

    if (!sessionId) {
      log.debug({ body: scrubDeep(body) }, 'prava webhook had no session id');
      return;
    }

    void (async () => {
      try {
        const orch = await orchestrator();
        const mandates = await orch.list(200);
        const mandate = mandates.find((m) => m.prava.sessionId === sessionId);
        if (!mandate) {
          log.warn({ sessionId }, 'prava webhook for unknown session');
          return;
        }

        if (/authoriz|approved|succeed|complete/.test(status)) {
          await orch.authorize(mandate.id, 'prava webhook');
        } else if (/declin|reject|cancel|fail/.test(status)) {
          await orch.reject(mandate.id, 'prava webhook', `session reported ${status}`);
        } else {
          log.info({ sessionId, status }, 'prava webhook status not actionable');
        }
      } catch (error) {
        log.error({ err: (error as Error).message }, 'prava webhook handling failed');
      }
    })();
  }),
);
