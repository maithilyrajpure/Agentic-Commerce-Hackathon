import { capabilities, env } from '../../config/env.js';
import { describeHttpError, HttpClient } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { scrubPan } from '../../lib/redact.js';

/**
 * Linq iMessage transport.
 *
 * Outbound messages are the user-visible surface of this agent, so a delivery
 * failure is a product failure, not a log line. We retry, we scrub card data
 * from every body on the way out, and we return a result object rather than
 * throwing — a failed receipt must never roll back a payment that succeeded.
 */

export interface SendResult {
  ok: boolean;
  detail: string;
  messageId?: string;
}

export class LinqClient {
  private readonly http: HttpClient;

  constructor(token: string = env.LINQ_API_TOKEN, baseUrl: string = env.LINQ_API_BASE) {
    this.http = new HttpClient({
      name: 'linq',
      baseURL: baseUrl,
      timeoutMs: 12_000,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      retry: { attempts: 3, baseDelayMs: 400, maxDelayMs: 4_000 },
    });
  }

  async send(toPhone: string, text: string, idempotencyKey?: string): Promise<SendResult> {
    const body = scrubPan(text);

    if (!capabilities.linq) {
      // Without a token, print the message so the flow is still observable.
      logger.info({ to: toPhone }, 'linq not configured; message would have been sent');
      console.log(`\n──────── iMessage → ${toPhone} ────────\n${body}\n────────────────────────────────────\n`);
      return { ok: false, detail: 'simulated (no LINQ_API_TOKEN)' };
    }

    try {
      const fromPhone = env.LINQ_PHONE_NUMBER || '+15124371883';
      const isPartnerV3 = env.LINQ_API_BASE.includes('/api/partner/v3');

      let response: Record<string, unknown>;
      if (isPartnerV3) {
        response = await this.http.post<Record<string, unknown>>(
          '/chats',
          {
            from: fromPhone,
            to: [toPhone],
            message: {
              parts: [{ type: 'text', value: body }],
            },
          },
          { idempotencyKey },
        );
      } else {
        response = await this.http.post<Record<string, unknown>>(
          '/v1/messages',
          {
            to: toPhone,
            ...(env.LINQ_PHONE_NUMBER ? { from: env.LINQ_PHONE_NUMBER } : {}),
            text: body,
          },
          { idempotencyKey },
        );
      }

      const messageId = typeof response?.id === 'string' ? response.id : (typeof response?.chat_id === 'string' ? response.chat_id : undefined);
      logger.info({ to: toPhone, messageId }, 'imessage sent');
      return { ok: true, detail: 'sent', messageId };
    } catch (error) {
      const detail = describeHttpError(error);
      logger.error({ to: toPhone, err: detail }, 'imessage send failed');
      return { ok: false, detail };
    }
  }
}

let singleton: LinqClient | null = null;
export function linqClient(): LinqClient {
  if (!singleton) singleton = new LinqClient();
  return singleton;
}
export function setLinqClient(client: LinqClient | null): void {
  singleton = client;
}

// --- Inbound payload parsing ------------------------------------------------

export interface InboundMessage {
  eventType: string;
  fromPhone: string;
  text: string;
  messageId?: string;
}

/**
 * Webhook bodies vary by provider version, so accept the shapes we have seen
 * rather than assuming one. An unparseable payload returns null and the route
 * still answers 200 — a webhook that 500s gets retried forever.
 */
export function parseInboundMessage(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, any>;

  const eventType: string = root.type ?? root.event ?? root.event_type ?? '';
  const data = (root.data ?? root.message ?? root.payload ?? root) as Record<string, any>;

  // Extract text from parts array (Linq v3 format) or text string
  let text = '';
  if (Array.isArray(data.parts)) {
    const textPart = data.parts.find((p: any) => p.type === 'text' || p.value || p.text);
    text = textPart?.value ?? textPart?.text ?? '';
  } else if (data.message && typeof data.message === 'object' && Array.isArray(data.message.parts)) {
    const textPart = data.message.parts.find((p: any) => p.type === 'text' || p.value || p.text);
    text = textPart?.value ?? textPart?.text ?? '';
  }
  if (!text || typeof text !== 'string') {
    text = data.text ?? data.body ?? data.message ?? data.content ?? (typeof root.text === 'string' ? root.text : '');
  }

  const fromPhone: string =
    data.from ??
    data.from_number ??
    data.fromPhone ??
    data.sender ??
    data.phone ??
    data.author ??
    data.handle ??
    data.sender_handle ??
    root.from ??
    root.sender ??
    '';
  const messageId: string | undefined = data.id ?? data.message_id ?? data.messageId ?? root.id;

  if (!fromPhone || typeof text !== 'string' || !text.trim()) return null;

  return { eventType: eventType || 'message.created', fromPhone: String(fromPhone), text: text.trim(), messageId };
}

/** Normalize phone numbers so "+1 555 000 1111" and "+15550001111" are one person. */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}
