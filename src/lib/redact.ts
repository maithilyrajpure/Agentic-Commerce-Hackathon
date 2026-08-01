/**
 * Card data must never reach a log line, an error message, or an LLM prompt.
 *
 * This is enforced in two places: the pino redaction paths in logger.ts handle
 * known object keys, and `scrubPan` here handles the harder case of a PAN that
 * has been string-interpolated into free text (a browser agent's extracted page
 * content, an upstream API's echoed error body).
 */

const PAN_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const CVV_KEYS = /\b(cvv|cvc|cvv2|csc|security[_\s-]?code)\b\s*[:=]\s*["']?\d{3,4}["']?/gi;

/** Digits-only Luhn check so we do not redact order numbers or timestamps. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function last4(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  return digits.slice(-4);
}

export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Replace any Luhn-valid card-length number in free text with a masked form. */
export function scrubPan(text: string): string {
  if (!text) return text;
  return text
    .replace(PAN_RE, (match) => {
      const digits = match.replace(/\D/g, '');
      return luhnValid(digits) ? maskPan(digits) : match;
    })
    .replace(CVV_KEYS, (m) => m.replace(/\d{3,4}(["']?)$/, '***$1'));
}

/** Recursively scrub an arbitrary value before it is logged or serialized. */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return scrubPan(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(pan|card_?number|cardNumber|cvv|cvc|number)$/i.test(k) && typeof v === 'string') {
        out[k] = maskPan(v);
      } else {
        out[k] = scrubDeep(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}
