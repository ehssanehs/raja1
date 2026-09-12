/**
 * Money handling — integer minor units + currency code, never floating point (ADR-0006).
 *
 * Rules enforced here:
 *  - amounts are safe integers in the currency's minor unit (IRR has 0 decimals, USD has 2)
 *  - every amount carries its currency; mixing currencies throws
 *  - multiplication/division use banker-free integer math with explicit rounding
 */

export const CURRENCIES = {
  IRR: { code: 'IRR', decimals: 0, symbol: 'ریال', symbolEn: 'IRR' },
  IRT: { code: 'IRT', decimals: 0, symbol: 'تومان', symbolEn: 'IRT' },
  USD: { code: 'USD', decimals: 2, symbol: '$', symbolEn: 'USD' },
  EUR: { code: 'EUR', decimals: 2, symbol: '€', symbolEn: 'EUR' },
} as const;

export type Currency = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

export interface Money {
  readonly amountMinor: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function decimalsOf(currency: Currency): number {
  return CURRENCIES[currency].decimals;
}

export function assertSafeMinor(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`amountMinor must be a safe integer, received ${amountMinor}`);
  }
}

export function money(amountMinor: number, currency: Currency): Money {
  assertSafeMinor(amountMinor);
  if (!isCurrency(currency)) throw new MoneyError(`unknown currency: ${String(currency)}`);
  return Object.freeze({ amountMinor, currency });
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function abs(a: Money): Money {
  return money(Math.abs(a.amountMinor), a.currency);
}

/** Sum of amounts; empty list requires an explicit currency. */
export function sum(amounts: readonly Money[], currency?: Currency): Money {
  if (amounts.length === 0) {
    if (!currency) throw new MoneyError('sum() of an empty list requires a currency');
    return zero(currency);
  }
  const first = amounts[0]!;
  return amounts.slice(1).reduce((acc, m) => add(acc, m), first);
}

/**
 * Multiply by a rational factor using integer math.
 * `multiply(m, 3, 2)` = 1.5x. Rounding is half-away-from-zero, explicitly.
 */
export function multiply(a: Money, numerator: number, denominator = 1): Money {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError('multiply() requires integer numerator and denominator');
  }
  if (denominator === 0) throw new MoneyError('multiply() denominator must not be zero');
  const raw = a.amountMinor * numerator;
  const sign = Math.sign(raw) === -1 ? -1 : 1;
  const quotient = Math.floor((Math.abs(raw) + Math.floor(denominator / 2)) / denominator);
  return money(sign * quotient, a.currency);
}

/** Apply a basis-point rate (10_000 bp = 100%). */
export function applyBasisPoints(a: Money, basisPoints: number): Money {
  if (!Number.isSafeInteger(basisPoints)) throw new MoneyError('basisPoints must be an integer');
  return multiply(a, basisPoints, 10_000);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function greaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function lessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/** Major-unit decimal string, e.g. 1850000 IRR -> "1850000", 1234 USD -> "12.34". */
export function toMajorString(a: Money): string {
  assertSafeMinor(a.amountMinor);
  const decimals = decimalsOf(a.currency);
  if (decimals === 0) return String(a.amountMinor);
  const sign = a.amountMinor < 0 ? '-' : '';
  const abs = Math.abs(a.amountMinor);
  const unit = Math.trunc(abs / 10 ** decimals);
  const frac = String(abs % 10 ** decimals).padStart(decimals, '0');
  return `${sign}${unit}.${frac}`;
}

/**
 * Parse a decimal major-unit string ("1850000", "12.34") into Money without float math.
 * Rejects more decimals than the currency supports and any non-numeric input.
 */
export function parseMajorString(input: string, currency: Currency): Money {
  const trimmed = input.trim().replace(/[,\s]/g, '');
  const match = /^(?<sign>-?)(?<int>\d+)(?:\.(?<frac>\d+))?$/.exec(trimmed);
  if (!match?.groups) throw new MoneyError(`invalid amount: "${input}"`);
  const decimals = decimalsOf(currency);
  const frac = match.groups['frac'] ?? '';
  if (frac.length > decimals) {
    throw new MoneyError(`too many decimal places for ${currency}: "${input}"`);
  }
  const padded = frac.padEnd(decimals, '0');
  const value = Number(`${match.groups['int']}${padded}`) * (match.groups['sign'] === '-' ? -1 : 1);
  return money(value, currency);
}

/** Localized display formatting (Persian digits for fa, grouping for en). */
export function format(a: Money, locale: 'fa' | 'en' = 'fa'): string {
  const decimals = decimalsOf(a.currency);
  const formatter = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${formatter.format(a.amountMinor / 10 ** decimals)} ${locale === 'fa' ? CURRENCIES[a.currency].symbol : CURRENCIES[a.currency].symbolEn}`;
}

/** Serializable form used at API boundaries. */
export interface MoneyDto {
  amountMinor: number;
  currency: Currency;
}

export function toDto(a: Money): MoneyDto {
  return { amountMinor: a.amountMinor, currency: a.currency };
}

export function fromDto(dto: MoneyDto): Money {
  return money(dto.amountMinor, dto.currency);
}
