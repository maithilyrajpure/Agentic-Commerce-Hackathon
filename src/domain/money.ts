/**
 * Money is an integer count of minor units (US cents). Never a float.
 *
 * `0.1 + 0.2 !== 0.3` is a rounding curiosity in most software and a
 * reconciliation defect in payments. Every amount that crosses a boundary in
 * this system — LLM output, Prava request, browser field, dashboard, ledger —
 * is converted at the edge and integer everywhere in between.
 */

export type Cents = number;

const CENTS_RE = /^-?\d+$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Parse a human/LLM-supplied amount ("45", "45.5", "$1,299.99") into cents. */
export function toCents(input: number | string): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Amount is not a finite number: ${input}`);
    if (input < 0) throw new MoneyError(`Amount cannot be negative: ${input}`);
    // Round half-up on the third decimal so 45.005 -> 4501, not 4500.
    const cents = Math.round((input + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(cents)) throw new MoneyError(`Amount out of safe range: ${input}`);
    return cents;
  }

  const cleaned = input.trim().replace(/[$,\s]/g, '').replace(/^USD/i, '');
  if (cleaned === '') throw new MoneyError('Amount is empty');

  if (CENTS_RE.test(cleaned)) return toCents(Number(cleaned));

  const match = /^-?\d+\.(\d+)$/.exec(cleaned);
  if (!match) throw new MoneyError(`Unparseable amount: ${JSON.stringify(input)}`);
  return toCents(Number(cleaned));
}

/** Render cents for humans: 4500 -> "45.00". */
export function formatCents(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Render cents with a currency prefix: 4500 -> "$45.00". */
export function formatUsd(cents: Cents): string {
  return `$${formatCents(cents)}`;
}

/** Cents as a decimal number, only for serializing to an external API. */
export function centsToDecimal(cents: Cents): number {
  return Math.trunc(cents) / 100;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => acc + Math.trunc(v), 0);
}
