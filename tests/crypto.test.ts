import { describe, expect, it } from 'vitest';
import { mintGrant, verifyGrant, verifyWebhookSignature } from '../src/lib/crypto.js';
import { maskPan, scrubDeep, scrubPan } from '../src/lib/redact.js';

describe('signed approval grants', () => {
  it('round-trips a valid grant', () => {
    const token = mintGrant('mdt_abc', 'approve', 30);
    const result = verifyGrant(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.mandateId).toBe('mdt_abc');
      expect(result.grant.action).toBe('approve');
    }
  });

  it('rejects a grant whose payload was edited to point at another mandate', () => {
    const token = mintGrant('mdt_cheap', 'approve', 30);
    const [body, sig] = token.split('.') as [string, string];
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.mandateId = 'mdt_expensive';
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}`;

    const result = verifyGrant(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired grant', () => {
    const result = verifyGrant(mintGrant('mdt_abc', 'approve', -1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects garbage without throwing', () => {
    for (const bad of ['', 'nope', 'a.b.c', '....']) {
      expect(verifyGrant(bad).ok).toBe(false);
    }
  });

  it('mints a different token every time, so links cannot be replayed by guessing', () => {
    const a = mintGrant('mdt_abc', 'approve', 30);
    const b = mintGrant('mdt_abc', 'approve', 30);
    expect(a).not.toBe(b);
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ session_id: 's_1', status: 'authorized' });
  const secret = 'shhh-a-real-secret-value';

  it('accepts a correct hex signature with or without the sha256= prefix', () => {
    const { createHmac } = require('node:crypto');
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, hex, secret)).toBe(true);
    expect(verifyWebhookSignature(body, `sha256=${hex}`, secret)).toBe(true);
  });

  it('rejects a wrong signature and a missing one', () => {
    expect(verifyWebhookSignature(body, 'deadbeef', secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects a signature computed over a different body', () => {
    const { createHmac } = require('node:crypto');
    const other = createHmac('sha256', secret).update('{"session_id":"s_2"}').digest('hex');
    expect(verifyWebhookSignature(body, other, secret)).toBe(false);
  });
});

describe('card redaction', () => {
  it('masks a real card number embedded in page text', () => {
    // Luhn-valid test PAN from the public Visa test range.
    const text = 'Payment declined for card 4111111111111111 at checkout';
    const scrubbed = scrubPan(text);
    expect(scrubbed).not.toContain('4111111111111111');
    expect(scrubbed).toContain('1111');
  });

  it('leaves order numbers and timestamps alone', () => {
    const text = 'Order 1234567890123456789 placed at 1717171717171';
    expect(scrubPan(text)).toContain('1234567890123456789');
  });

  it('masks card fields anywhere in a nested object', () => {
    const scrubbed = scrubDeep({
      card: { cardNumber: '4111111111111111', cvv: '123' },
      nested: [{ pan: '4111111111111111' }],
    }) as any;
    expect(JSON.stringify(scrubbed)).not.toContain('4111111111111111');
    expect(scrubbed.card.cardNumber).toBe(maskPan('4111111111111111'));
  });

  it('strips a cvv written as free text', () => {
    expect(scrubPan('cvv: 797')).not.toContain('797');
  });
});
