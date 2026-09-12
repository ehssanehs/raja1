/**
 * Time handling (spec § 88).
 *
 *  - storage and domain logic are always UTC
 *  - "date-only" values (travel dates, release dates) are ISO `YYYY-MM-DD` strings in the
 *    *provider's* local timezone; they are never converted to UTC timestamps implicitly
 *  - conversions between a provider-local wall clock and UTC go through this module only
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export type DateOnly = string; // YYYY-MM-DD
export type TimeOfDay = string; // HH:mm (24h)

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export function toIso(date: Date): string {
  return date.toISOString();
}

export function fromIso(iso: string): Date {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`invalid ISO timestamp: ${iso}`);
  return parsed;
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * MS_PER_SECOND);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function addHours(date: Date, hours: number): Date {
  return addMinutes(date, hours * 60);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function differenceInSeconds(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_SECOND);
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

export function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

export function clampDate(value: Date, lower: Date, upper: Date): Date {
  if (value.getTime() < lower.getTime()) return lower;
  if (value.getTime() > upper.getTime()) return upper;
  return value;
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** Wall-clock parts of an instant in the given timezone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new RangeError(`missing ${type} for timezone ${timeZone}`);
    return Number(found.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset (in minutes) of a timezone at a given instant; positive east of UTC. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - instant.getTime()) / MS_PER_MINUTE);
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function dateOnlyInZone(instant: Date, timeZone: string): DateOnly {
  const p = zonedParts(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Convert a provider-local wall clock (date + HH:mm) in `timeZone` to the corresponding UTC instant.
 * Uses the two-pass offset technique, which is correct for all fixed-offset zones (Iran has no DST
 * since 2022, but this also handles DST transitions safely by re-checking the offset).
 */
export function zonedDateTimeToUtc(date: DateOnly, time: TimeOfDay, timeZone: string): Date {
  if (!DATE_ONLY_RE.test(date)) throw new RangeError(`invalid date-only value: ${date}`);
  if (!TIME_OF_DAY_RE.test(time)) throw new RangeError(`invalid time-of-day value: ${time}`);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = new Date(naiveUtc - zoneOffsetMinutes(new Date(naiveUtc), timeZone) * MS_PER_MINUTE);
  const secondGuess = new Date(naiveUtc - zoneOffsetMinutes(firstGuess, timeZone) * MS_PER_MINUTE);
  return secondGuess;
}

export function formatInZone(instant: Date, timeZone: string, locale: 'fa' | 'en' = 'fa'): string {
  const formatter = new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : 'en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return formatter.format(instant);
}

/** Inclusive list of date-only values from start to end (max `limit` entries). */
export function dateRange(start: DateOnly, end: DateOnly, limit = 62): DateOnly[] {
  if (!DATE_ONLY_RE.test(start) || !DATE_ONLY_RE.test(end)) {
    throw new RangeError('dateRange requires YYYY-MM-DD values');
  }
  const result: DateOnly[] = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) {
    throw new RangeError('dateRange received an unparseable date');
  }
  if (cursor.getTime() > last.getTime()) return [];
  while (cursor.getTime() <= last.getTime()) {
    result.push(cursor.toISOString().slice(0, 10));
    if (result.length > limit) {
      throw new RangeError(`date range exceeds the maximum of ${limit} days`);
    }
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }
  return result;
}

export function dateRangeSize(start: DateOnly, end: DateOnly): number {
  return dateRange(start, end).length;
}

/** Deterministic PRNG (mulberry32) so jitter/backoff are reproducible in tests. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const defaultRng = createRng(0x5eed1e);

/**
 * Jittered delay: `baseSeconds ± ratio` (default ±25%), never below `minSeconds`.
 * Used by the scheduler to avoid synchronised swarms (spec § 12).
 */
export function jitterSeconds(
  baseSeconds: number,
  options: { ratio?: number; minSeconds?: number; rng?: () => number } = {},
): number {
  const ratio = options.ratio ?? 0.25;
  const minSeconds = options.minSeconds ?? 1;
  const rng = options.rng ?? defaultRng;
  const delta = baseSeconds * ratio;
  const value = baseSeconds - delta + rng() * delta * 2;
  return Math.max(minSeconds, Math.round(value));
}

/** Exponential backoff with a cap and (optionally) jitter. */
export function backoffSeconds(
  attempt: number,
  options: { baseSeconds?: number; factor?: number; maxSeconds?: number; jitterRatio?: number; rng?: () => number } = {},
): number {
  const base = options.baseSeconds ?? 5;
  const factor = options.factor ?? 2;
  const max = options.maxSeconds ?? 900;
  const raw = Math.min(max, base * Math.pow(factor, Math.max(0, attempt - 1)));
  if (!options.jitterRatio) return Math.round(raw);
  return jitterSeconds(raw, { ratio: options.jitterRatio, minSeconds: 1, rng: options.rng });
}

/** Parse an ISO-8601 duration like `PT10M`, `P1D` (subset used by configuration). */
export function parseDurationToSeconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) throw new RangeError(`unsupported duration: ${value}`);
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}
