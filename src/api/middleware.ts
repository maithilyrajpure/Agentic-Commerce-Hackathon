import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../domain/errors.js';
import { logger, newCorrelationId } from '../lib/logger.js';
import { scrubDeep } from '../lib/redact.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      rawBody?: string;
    }
  }
}

/** Tag every request so a mandate can be traced across logs. */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  req.correlationId = (req.header('x-request-id') || newCorrelationId()).slice(0, 64);
  res.setHeader('x-request-id', req.correlationId);
  next();
}

/**
 * Capture the raw body during JSON parsing. HMAC signatures are computed over
 * exact bytes, so re-serializing the parsed object would produce a different
 * string and fail verification for reasons that take hours to find.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  if (buf?.length) req.rawBody = buf.toString('utf8');
}

export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many webhook deliveries; slow down.' },
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/** Authorization links are guessable-adjacent; throttle them hard. */
export const authorizeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many authorization attempts.' },
});

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'No such route' });
}

/** Typed errors become their own status; everything else is a 500 with no detail leaked. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const log = logger.child({ correlationId: req.correlationId, path: req.path });

  if (err instanceof AppError) {
    log.warn({ code: err.code, status: err.status, detail: scrubDeep(err.detail) }, err.message);
    res.status(err.status).json({ error: err.code, message: err.message, detail: scrubDeep(err.detail) });
    return;
  }

  log.error({ err: (err as Error)?.message, stack: (err as Error)?.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong on our side.' });
}
