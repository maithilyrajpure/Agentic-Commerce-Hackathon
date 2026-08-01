import { describe, expect, it } from 'vitest';
import { centsToDecimal, formatCents, formatUsd, sumCents, toCents, MoneyError } from '../src/domain/money.js';

describe('money', () => {
  it('parses the shapes an LLM and a human actually produce', () => {
    expect(toCents(45)).toBe(4500);
    expect(toCents(45.5)).toBe(4550);
    expect(toCents('45')).toBe(4500);
    expect(toCents('$45.00')).toBe(4500);
    expect(toCents('$1,299.99')).toBe(129_999);
    expect(toCents('USD 20')).toBe(2000);
    expect(toCents(' 12.30 ')).toBe(1230);
  });

  it('does not lose a cent to binary floating point', () => {
    // 0.1 + 0.2 as dollars is the classic reconciliation defect.
    expect(sumCents([toCents(0.1), toCents(0.2)])).toBe(toCents(0.3));
    expect(toCents(1.005)).toBe(101);
    expect(toCents(19.99) * 3).toBe(5997);
  });

  it('refuses nonsense rather than coercing it to zero', () => {
    expect(() => toCents('free')).toThrow(MoneyError);
    expect(() => toCents(-5)).toThrow(MoneyError);
    expect(() => toCents(Number.NaN)).toThrow(MoneyError);
    expect(() => toCents(Infinity)).toThrow(MoneyError);
  });

  it('formats for humans', () => {
    expect(formatCents(4500)).toBe('45.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatUsd(129_999)).toBe('$1,299.99');
    expect(centsToDecimal(4550)).toBe(45.5);
  });
});
