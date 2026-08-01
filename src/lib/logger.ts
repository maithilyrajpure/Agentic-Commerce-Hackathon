import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured JSON logs in production, human-readable in development.
 * Redaction paths are declared here so a careless `logger.info({ card })`
 * cannot leak a PAN even if someone forgets to call scrubDeep first.
 */
const redactPaths = [
  'card.number',
  'card.cardNumber',
  'card.pan',
  'card.cvv',
  'card.cvc',
  'cardData.cardNumber',
  'cardData.cvv',
  'cardData.cvc',
  '*.cardNumber',
  '*.card_number',
  '*.cvv',
  '*.cvc',
  '*.pan',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'PRAVA_API_KEY',
  'OPENAI_API_KEY',
  'LINQ_API_TOKEN',
  'BROWSERBASE_API_KEY',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[redacted]' },
  base: { service: 'mandate-manager' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export type Logger = typeof logger;

/** A child logger bound to one mandate, so every line is traceable. */
export function mandateLogger(mandateId: string, extra: Record<string, unknown> = {}) {
  return logger.child({ mandateId, ...extra });
}

export function newCorrelationId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
