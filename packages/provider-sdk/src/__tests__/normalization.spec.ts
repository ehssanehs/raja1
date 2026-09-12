/**
 * Normalization rules (spec § 88: UTC storage, provider-local search, no floating-point money).
 *
 * Providers give us Persian text, Persian digits, Rial/Toman amounts and local wall-clock times.
 * These tests fix the conversions so every adapter produces identical canonical shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLocalFilters,
  dedupeTrips,
  mapCoachClass,
  mapCoachClassOrThrow,
  minutesBetween,
  parseInteger,
  parseProviderDateTime,
  parseProviderMoney,
  sortTrips,
  toAsciiNumberString,
  toMinorUnits,
  tripFingerprint,
} from '../normalize';
import type { ProviderTrip } from '../types';

function trip(overrides: Partial<ProviderTrip> = {}): ProviderTrip {
  const base: ProviderTrip = {
    providerTripId: 'T1',
    trainNumber: '101',
    trainName: 'Test Express',
    coachClass: 'SECOND',
    departureAt: '2026-03-01T06:15:00.000Z',
    arrivalAt: '2026-03-01T12:15:00.000Z',
    durationMinutes: 360,
    originCode: 'THR',
    destinationCode: 'MHD',
    price: { amountMinor: 2_000_000, currency: 'IRR' },
    seatsAvailable: 10,
    seatLabels: ['101'],
    fingerprint: '',
    leg: 'OUTBOUND',
  };
  const merged = { ...base, ...overrides };
  merged.fingerprint = overrides.fingerprint ?? tripFingerprint(merged);
  return merged;
}

describe('numeric normalization', () => {
  it('converts Persian and Arabic digits', () => {
    expect(toAsciiNumberString('۱٬۲۳۴٫۵')).toBe('12345');
    expect(toAsciiNumberString('٢٫٠٠٠')).toBe('2000');
  });

  it('strips separators and rejects junk', () => {
    expect(parseInteger('۲٬۵۰۰٬۰۰۰')).toBe(2_500_000);
    expect(parseInteger(' 1,250 ')).toBe(1250);
    expect(parseInteger('-')).toBeNull();
    expect(parseInteger('—')).toBeNull();
    expect(parseInteger(null)).toBeNull();
    expect(parseInteger(42.7)).toBe(42);
  });

  it('keeps money in integer minor units with a currency', () => {
    expect(parseProviderMoney('۲٬۵۰۰٬۰۰۰', 'IRR')).toEqual({ amountMinor: 2_500_000, currency: 'IRR' });
    expect(parseProviderMoney(null, 'IRR')).toBeNull();
    expect(toMinorUnits(12, 'USD')).toBe(1200);
    expect(toMinorUnits(12.34, 'EUR')).toBe(1234);
    // Rial has no subunit in practice: the value is already minor.
    expect(toMinorUnits(2_500_000, 'IRR')).toBe(2_500_000);
  });
});

describe('coach class mapping', () => {
  it('maps English and Persian labels', () => {
    expect(mapCoachClass('1')).toBe('FIRST');
    expect(mapCoachClass('دو تخته')).toBe('SECOND');
    expect(mapCoachClass('کوپه')).toBe('COUPE');
    expect(mapCoachClass('هتل')).toBe('BED');
    expect(mapCoachClass('')).toBe('ANY');
  });

  it('flags unrecognised labels instead of silently mis-booking a class', () => {
    // Empty/absent labels legitimately mean "any class" and must not throw.
    expect(mapCoachClassOrThrow('')).toBe('ANY');
    expect(mapCoachClassOrThrow(null)).toBe('ANY');
    expect(() => mapCoachClassOrThrow('کلاس ناشناخته')).toThrowError(/unrecognised coach class/i);
  });
});

describe('provider-local time handling', () => {
  it('interprets wall-clock times in the provider timezone and stores UTC', () => {
    // Tehran is UTC+03:30 (no DST since 2022).
    expect(parseProviderDateTime('2026-03-01', '08:30', 'Asia/Tehran')).toBe('2026-03-01T05:00:00.000Z');
    expect(parseProviderDateTime('2026-03-01', '۰۸:۳۰', 'Asia/Tehran')).toBe('2026-03-01T05:00:00.000Z');
    expect(parseProviderDateTime('2026-03-01', '08:30:15', 'Asia/Tehran')).toBe('2026-03-01T05:00:15.000Z');
    expect(parseProviderDateTime('2026-03-01', '23:59', 'UTC')).toBe('2026-03-01T23:59:00.000Z');
  });

  it('rejects impossible times instead of guessing', () => {
    expect(parseProviderDateTime('2026-03-01', '25:00', 'Asia/Tehran')).toBeNull();
    expect(parseProviderDateTime('2026-03-01', 'not a time', 'Asia/Tehran')).toBeNull();
    expect(parseProviderDateTime('2026-03-01', null, 'Asia/Tehran')).toBeNull();
  });

  it('computes durations only for sane intervals', () => {
    expect(minutesBetween('2026-03-01T06:00:00.000Z', '2026-03-01T12:30:00.000Z')).toBe(390);
    expect(minutesBetween('2026-03-01T06:00:00.000Z', null)).toBeNull();
    expect(minutesBetween('2026-03-01T06:00:00.000Z', '2026-03-01T05:00:00.000Z')).toBeNull();
  });
});

describe('trip identity and selection', () => {
  it('fingerprints the offer, not the object identity', () => {
    const first = trip();
    const second = trip();
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(trip({ seatsAvailable: 11 }).fingerprint).not.toBe(first.fingerprint);
    expect(trip({ price: { amountMinor: 2_100_000, currency: 'IRR' } }).fingerprint).not.toBe(first.fingerprint);
  });

  it('deduplicates identical offers and keeps the better one', () => {
    const worse = trip({ seatsAvailable: 2 });
    const better = trip({ seatsAvailable: 9, fingerprint: worse.fingerprint });
    const deduped = dedupeTrips([worse, better, worse]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.seatsAvailable).toBe(9);
  });

  it('keeps outbound and return legs separate even with identical fingerprints', () => {
    const outbound = trip();
    const inbound = trip({ leg: 'RETURN', fingerprint: outbound.fingerprint });
    expect(dedupeTrips([outbound, inbound])).toHaveLength(2);
  });

  it('sorts by departure, then price, then id (deterministic)', () => {
    const later = trip({ providerTripId: 'B', departureAt: '2026-03-01T09:00:00.000Z' });
    const earlier = trip({ providerTripId: 'A', departureAt: '2026-03-01T06:00:00.000Z' });
    expect(sortTrips([later, earlier]).map((item) => item.providerTripId)).toEqual(['A', 'B']);
  });

  it('applies price and availability filters locally when the provider cannot', () => {
    const cheap = trip({ price: { amountMinor: 1_000_000, currency: 'IRR' }, seatsAvailable: 5 });
    const expensive = trip({
      providerTripId: 'T2',
      price: { amountMinor: 5_000_000, currency: 'IRR' },
      seatsAvailable: 5,
    });
    const filtered = applyLocalFilters([cheap, expensive], { maxPriceMinor: 2_000_000 }, {
      priceFilteringSupported: false,
    });
    expect(filtered.map((item) => item.providerTripId)).toEqual(['T1']);
    // When the provider filters server-side, we trust it and do not second-guess the result set.
    expect(
      applyLocalFilters([cheap, expensive], { maxPriceMinor: 2_000_000 }, { priceFilteringSupported: true }),
    ).toHaveLength(2);
    expect(applyLocalFilters([cheap], { minAvailability: 6 }, { priceFilteringSupported: false })).toHaveLength(0);
  });
});
