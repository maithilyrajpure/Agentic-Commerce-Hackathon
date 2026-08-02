import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Approval links are the weakest point in any "click here to authorize spend"
 * flow. A bare `?sessionId=...` link is a bearer token with no integrity,
 * no audience, and no expiry — guess the id and you have spent someone's money.
 *
 * We sign an explicit tuple (mandateId, action, expiry, nonce) and verify it in
 * constant time. The signature is bound to the mandate, so a link minted for
 * mandate A cannot authorize mandate B.
 */

export interface SignedGrant {
  mandateId: string;
  action: 'approve' | 'reject';
  exp: number;
  nonce: string;
}

function payloadOf(g: SignedGrant): string {
  return `${g.mandateId}.${g.action}.${g.exp}.${g.nonce}`;
}

export function sign(payload: string, secret: string = env.CALLBACK_SIGNING_SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function mintGrant(mandateId: string, action: 'approve' | 'reject', ttlMinutes: number): string {
  const grant: SignedGrant = {
    mandateId,
    action,
    exp: Date.now() + ttlMinutes * 60_000,
    nonce: randomBytes(9).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${body}.${sign(payloadOf(grant))}`;
}

export type GrantVerification =
  | { ok: true; grant: SignedGrant }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyGrant(token: string): GrantVerification {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts as [string, string];

  let grant: SignedGrant;
  try {
    grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedGrant;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!grant?.mandateId || !grant?.action || typeof grant.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (!safeEqual(sign(payloadOf(grant)), signature)) return { ok: false, reason: 'bad_signature' };
  if (Date.now() > grant.exp) return { ok: false, reason: 'expired' };
  return { ok: true, grant };
}

/**
 * Verify an inbound webhook HMAC. Providers differ on the exact header and
 * prefix, so we accept the common `sha256=<hex>` and bare-hex/base64 forms.
 */
export function verifyWebhookSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!secret) return true; // Not configured: caller decides whether to enforce.
  if (!header) return false;
  const provided = header.replace(/^sha256=/i, '').trim();
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const b64 = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(provided, hex) || safeEqual(provided, b64);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A 6-digit approval PIN derived deterministically from the mandate id and the
 * signing secret. Nothing to store: the same value can be re-derived wherever
 * the secret is known — computed once for the approval message, checked again
 * when the approver submits it. It is the fallback second factor for approvers
 * on a device without a fingerprint or Face ID sensor.
 */
export function approvalPin(mandateId: string, secret: string = env.CALLBACK_SIGNING_SECRET): string {
  const digest = createHmac('sha256', secret).update(`approval-pin:${mandateId}`).digest();
  // First 4 bytes -> unsigned int -> 6 digits, zero-padded.
  const n = digest.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Constant-time check of a submitted approval PIN. */
export function verifyApprovalPin(mandateId: string, submitted: string): boolean {
  const expected = approvalPin(mandateId);
  const clean = String(submitted ?? '').replace(/\D/g, '');
  return clean.length === expected.length && safeEqual(clean, expected);
}
