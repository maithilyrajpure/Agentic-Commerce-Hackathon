import express, { type Express } from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { env } from './config/env.js';
import { captureRawBody, correlationId, errorHandler, notFound } from './api/middleware.js';
import { authorizeRouter } from './api/routes/authorize.js';
import { healthRouter } from './api/routes/health.js';
import { linqRouter } from './api/routes/linqWebhook.js';
import { mandateRouter } from './api/routes/mandates.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The approval and dashboard pages inline their script and styles so
          // the whole flow is one file with no build step. Fonts come from
          // Google; nothing else is permitted, and there is no remote script
          // origin at all.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      // Approval links are opened from a text message; a referrer carrying the
      // signed grant must not leak to any third party.
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(correlationId);
  app.use(express.json({ limit: '256kb', verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  app.use(healthRouter);
  app.use(linqRouter);
  app.use(authorizeRouter);
  app.use(mandateRouter);

  // Shared design tokens. Linked rather than inlined so the approval pages and
  // the dashboard cannot drift apart visually.
  app.get('/tokens.css', (_req, res) => {
    res.type('text/css').setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(join(here, 'web', 'tokens.css'));
  });
  app.get('/dashboard', (_req, res) => res.sendFile(join(here, 'web', 'dashboard.html')));
  app.get('/', (_req, res) => res.redirect(302, '/dashboard'));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export { env };
