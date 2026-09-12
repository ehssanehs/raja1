import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  add,
  applyBasisPoints,
  compare,
  equals,
  format,
  fromDto,
  greaterThan,
  lessThan,
  min,
  money,
  multiply,
  negate,
  parseMajorString,
  subtract,
  sum,
  toDto,
  toMajorString,
  zero,
} from '../money';

describe('money', () => {
  it('rejects non-integer or unsafe minor amounts', () => {
    expect(() => money(1.5, 'IRR')).toThrow(MoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'IRR')).toThrow(MoneyError);
    expect(() => money(Number.NaN, 'USD')).toThrow(MoneyError);
  });

  it('adds and subtracts within one currency and refuses to mix currencies', () => {
    const a = money(1_500_000, 'IRR');
    const b = money(250_000, 'IRR');
    expect(add(a, b).amountMinor).toBe(1_750_000);
    expect(subtract(a, b).amountMinor).toBe(1_250_000);
    expect(() => add(a, money(100, 'USD'))).toThrow(/currency mismatch/);
  });

  it('sums lists and requires a currency for the empty case', () => {
    expect(sum([money(100, 'IRR'), money(200, 'IRR')]).amountMinor).toBe(300);
    expect(sum([], 'USD').amountMinor).toBe(0);
    expect(() => sum([])).toThrow(MoneyError);
  });

  it('multiplies with explicit half-away-from-zero rounding', () => {
    expect(multiply(money(999, 'IRR'), 1, 2).amountMinor).toBe(500);
    expect(multiply(money(1_000, 'IRR'), 3, 2).amountMinor).toBe(1_500);
    expect(multiply(money(-999, 'IRR'), 1, 2).amountMinor).toBe(-500);
    expect(() => multiply(money(1, 'IRR'), 1, 0)).toThrow(MoneyError);
  });

  it('applies basis points without floating point drift', () => {
    // 5% of 1,850,000 = 92,500
    expect(applyBasisPoints(money(1_850_000, 'IRR'), 500).amountMinor).toBe(92_500);
    // 0.5% of 999 = 4.995 → 5 (half away from zero)
    expect(applyBasisPoints(money(999, 'IRR'), 50).amountMinor).toBe(5);
  });

  it('compares and orders amounts', () => {
    const a = money(100, 'IRR');
    const b = money(200, 'IRR');
    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, money(100, 'IRR'))).toBe(0);
    expect(greaterThan(b, a)).toBe(true);
    expect(lessThan(a, b)).toBe(true);
    expect(equals(a, money(100, 'IRR'))).toBe(true);
    expect(min(a, b)).toEqual(a);
    expect(negate(a).amountMinor).toBe(-100);
    expect(zero('IRR').amountMinor).toBe(0);
  });

  it('renders major units without precision loss', () => {
    expect(toMajorString(money(1_850_000, 'IRR'))).toBe('1850000');
    expect(toMajorString(money(1234, 'USD'))).toBe('12.34');
    expect(toMajorString(money(-5, 'USD'))).toBe('-0.05');
    expect(toMajorString(money(0, 'EUR'))).toBe('0.00');
  });

  it('parses major-unit strings safely and validates decimals', () => {
    expect(parseMajorString('1,850,000', 'IRR').amountMinor).toBe(1_850_000);
    expect(parseMajorString('12.34', 'USD').amountMinor).toBe(1234);
    expect(parseMajorString('-0.05', 'USD').amountMinor).toBe(-5);
    expect(() => parseMajorString('12.345', 'USD')).toThrow(/decimal places/);
    expect(() => parseMajorString('abc', 'IRR')).toThrow(MoneyError);
  });

  it('round-trips through the DTO boundary', () => {
    const value = money(987_654, 'IRR');
    expect(fromDto(toDto(value))).toEqual(value);
  });

  it('formats for Persian and English locales', () => {
    const value = money(1_850_000, 'IRR');
    expect(format(value, 'fa')).toContain('ریال');
    expect(format(value, 'en')).toContain('IRR');
    // Persian formatting uses Persian digits
    expect(format(value, 'fa')).toMatch(/[۰-۹]/);
  });
});
