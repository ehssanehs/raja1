/**
 * Normalization helpers shared by every adapter.
 *
 * Provider pages are Persian-language, use Persian digits, local wall-clock times and amounts with
 * separators. Every adapter must produce the same canonical shapes: ASCII digits, UTC instants,
 * integer minor units with an explicit currency, and English enum values.
 */
import { createHash } from 'node:crypto';
import { AppError, normalizeDigits, zonedDateTimeToUtc, type CoachClass, type Money } from '@raja/shared';

/** Local hash helper: `provider-sdk` must not depend on the crypto package (layer rule). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
import type { ProviderTrip } from './types';

/** Convert Persian/Arabic digits and strip thousands separators (`,`/`،`/`٫`/spaces). */
export function toAsciiNumberString(input: string): string {
  return normalizeDigits(input)
    .replace(/[\s\u200c\u200f,،٫]/g, '')
    .replace(/[^\d.-]/g, '');
}

export function parseInteger(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.trunc(input) : null;
  const cleaned = toAsciiNumberString(input);
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Parse a provider amount (already in minor units when `minorUnits` is true). */
export function parseProviderMoney(
  input: string | number | null | undefined,
  currency: Money['currency'],
  options: { minorUnits?: boolean } = {},
): Money | null {
  const value = parseInteger(input);
  if (value === null) return null;
  const minor = options.minorUnits ? value : toMinorUnits(value, currency);
  return { amountMinor: minor, currency };
}

/**
 * IRI Rial is quoted in whole rials everywhere (no subunits in practice); Toman is rials/10.
 * Keeping the conversion in one place avoids the classic factor-of-ten bug.
 */
export function toMinorUnits(amount: number, currency: Money['currency']): number {
  switch (currency) {
    case 'IRR':
      return Math.round(amount);
    case 'IRT':
      return Math.round(amount);
    case 'USD':
    case 'EUR':
      return Math.round(amount * 100);
    default:
      return Math.round(amount);
  }
}

/** Interpret a provider-local wall-clock timestamp in the provider's zone and return a UTC ISO. */
export function parseProviderDateTime(
  localDate: string,
  localTime: string | null | undefined,
  timezone: string,
): string | null {
  if (!localTime) return null;
  const time = normalizeDigits(localTime).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const timeOfDay = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  try {
    const instant = zonedDateTimeToUtc(localDate, timeOfDay, timezone);
    // `zonedDateTimeToUtc` works at minute precision (provider schedules never publish seconds);
    // re-add seconds afterwards so parsing stays lossless.
    return new Date(instant.getTime() + second * 1_000).toISOString();
  } catch {
    return null;
  }
}

const CLASS_MAP: Record<string, CoachClass> = {
  // Numeric labels used by Iranian rail operators, plus the Persian words for compartments.
  '1': 'FIRST',
  first: 'FIRST',
  'یک': 'FIRST',
  'یک تخته': 'FIRST',
  '2': 'SECOND',
  second: 'SECOND',
  'دو': 'SECOND',
  'دو تخته': 'SECOND',
  '3': 'ECONOMY',
  third: 'ECONOMY',
  'سه': 'ECONOMY',
  'سه تخته': 'ECONOMY',
  '4': 'ECONOMY',
  fourth: 'ECONOMY',
  'چهار': 'ECONOMY',
  'چهار تخته': 'ECONOMY',
  '5': 'ECONOMY',
  '6': 'ECONOMY',
  sixth: 'ECONOMY',
  '6th': 'ECONOMY',
  sleeper: 'SLEEPER',
  'تخت': 'SLEEPER',
  coupe: 'COUPE',
  'کوپه': 'COUPE',
  'کوپه‌ای': 'COUPE',
  bed: 'BED',
  hotel: 'BED',
  'هتل': 'BED',
};

export function mapCoachClass(label: string | null | undefined): CoachClass {
  if (!label) return 'ANY';
  const key = normalizeDigits(label).trim().toLowerCase();
  return CLASS_MAP[key] ?? 'ANY';
}

export function mapCoachClassOrThrow(label: string | null | undefined): CoachClass {
  const mapped = mapCoachClass(label);
  if (mapped === 'ANY' && label && label.trim() !== '') {
    throw new AppError('PROVIDER_ERROR', `unrecognised coach class from provider: ${label.slice(0, 40)}`, {
      userMessageKey: 'error.provider_error',
      details: { kind: 'SCHEMA' },
    });
  }
  return mapped;
}

export function minutesBetween(startIso: string, endIso: string | null): number | null {
  if (!endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const minutes = Math.round((end - start) / 60_000);
  return minutes >= 0 ? minutes : null;
}

/**
 * Fingerprint of an offer: same train, same class, same times, same price ⇒ same fingerprint.
 * Used for change detection (availability_observations) and duplicate suppression.
 */
export function tripFingerprint(
  trip: Pick<ProviderTrip, 'providerTripId' | 'coachClass' | 'departureAt' | 'arrivalAt' | 'price' | 'seatsAvailable'>,
): string {
  const parts = [
    trip.providerTripId,
    trip.coachClass,
    trip.departureAt,
    trip.arrivalAt ?? '',
    trip.price ? `${trip.price.amountMinor}${trip.price.currency}` : '',
    String(trip.seatsAvailable),
  ];
  return sha256Hex(parts.join('|')).slice(0, 32);
}

export function dedupeTrips(trips: readonly ProviderTrip[]): ProviderTrip[] {
  const seen = new Map<string, ProviderTrip>();
  for (const trip of trips) {
    const key = `${trip.leg}:${trip.fingerprint}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, trip);
      continue;
    }
    // Keep the better offer (more seats, then lower price) — deterministic and documented.
    const better =
      trip.seatsAvailable > existing.seatsAvailable ||
      (trip.seatsAvailable === existing.seatsAvailable &&
        (trip.price?.amountMinor ?? Number.MAX_SAFE_INTEGER) <
          (existing.price?.amountMinor ?? Number.MAX_SAFE_INTEGER));
    if (better) seen.set(key, trip);
  }
  return [...seen.values()];
}

export function sortTrips(trips: readonly ProviderTrip[]): ProviderTrip[] {
  return [...trips].sort((a, b) => {
    const byDeparture = Date.parse(a.departureAt) - Date.parse(b.departureAt);
    if (byDeparture !== 0) return byDeparture;
    const byPrice = (a.price?.amountMinor ?? Number.MAX_SAFE_INTEGER) - (b.price?.amountMinor ?? Number.MAX_SAFE_INTEGER);
    if (byPrice !== 0) return byPrice;
    return a.providerTripId.localeCompare(b.providerTripId);
  });
}

/** Apply the user's constraints client-side when the provider cannot filter server-side. */
export function applyLocalFilters(
  trips: readonly ProviderTrip[],
  request: { maxPriceMinor?: number | undefined; minAvailability?: number | undefined; preferredTripIds?: readonly string[] | undefined },
  options: { priceFilteringSupported: boolean },
): ProviderTrip[] {
  return trips.filter((trip) => {
    if (request.minAvailability !== undefined && trip.seatsAvailable < request.minAvailability) return false;
    if (
      !options.priceFilteringSupported &&
      request.maxPriceMinor !== undefined &&
      trip.price !== null &&
      trip.price.amountMinor > request.maxPriceMinor
    ) {
      return false;
    }
    return true;
  });
}
