import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  addDays,
  backoffSeconds,
  createRng,
  dateOnlyInZone,
  dateRange,
  dateRangeSize,
  differenceInSeconds,
  formatInZone,
  fromIso,
  isTimezone,
  jitterSeconds,
  parseDurationToSeconds,
  toIso,
  zonedDateTimeToUtc,
  zonedParts,
  zoneOffsetMinutes,
} from '../time';

const TEHRAN = 'Asia/Tehran';

describe('time', () => {
  it('stores and round-trips UTC instants', () => {
    const iso = '2026-08-10T05:00:00.000Z';
    expect(toIso(fromIso(iso))).toBe(iso);
    expect(() => fromIso('not-a-date')).toThrow(RangeError);
  });

  it('exposes a deterministic clock for tests', () => {
    const clock = new FixedClock(new Date('2026-08-10T05:00:00.000Z'));
    expect(toIso(clock.now())).toBe('2026-08-10T05:00:00.000Z');
    clock.advanceSeconds(90);
    expect(toIso(clock.now())).toBe('2026-08-10T05:01:30.000Z');
  });

  it('validates timezones', () => {
    expect(isTimezone(TEHRAN)).toBe(true);
    expect(isTimezone('Not/AZone')).toBe(false);
  });

  it('computes zoned wall-clock parts and offsets', () => {
    // Iran Standard Time is UTC+03:30 (no DST since 2022)
    const instant = new Date('2026-08-10T05:00:00.000Z');
    expect(zoneOffsetMinutes(instant, TEHRAN)).toBe(210);
    expect(zonedParts(instant, TEHRAN)).toMatchObject({ year: 2026, month: 8, day: 10, hour: 8, minute: 30 });
    expect(dateOnlyInZone(instant, TEHRAN)).toBe('2026-08-10');
    expect(dateOnlyInZone(new Date('2026-08-10T21:30:00.000Z'), TEHRAN)).toBe('2026-08-11');
  });

  it('converts provider-local release times to UTC exactly (TM-26)', () => {
    // Official presale windows start at 08:30 local time in Iran.
    const utc = zonedDateTimeToUtc('2026-08-10', '08:30', TEHRAN);
    expect(toIso(utc)).toBe('2026-08-10T05:00:00.000Z');
    // ... and back to the same wall clock
    expect(zonedParts(utc, TEHRAN)).toMatchObject({ hour: 8, minute: 30 });

    // A late-evening local time crosses the UTC date boundary
    expect(toIso(zonedDateTimeToUtc('2026-08-10', '23:45', TEHRAN))).toBe('2026-08-10T20:15:00.000Z');
    expect(() => zonedDateTimeToUtc('10-08-2026', '08:30', TEHRAN)).toThrow(RangeError);
    expect(() => zonedDateTimeToUtc('2026-08-10', '25:00', TEHRAN)).toThrow(RangeError);
  });

  it('formats instants in a zone', () => {
    const formatted = formatInZone(new Date('2026-08-10T05:00:00.000Z'), TEHRAN, 'en');
    expect(formatted).toContain('2026');
    expect(formatInZone(new Date('2026-08-10T05:00:00.000Z'), TEHRAN, 'fa')).toMatch(/[۰-۹]/);
  });

  it('builds inclusive date ranges with a cap', () => {
    expect(dateRange('2026-10-10', '2026-10-12')).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(dateRangeSize('2026-10-10', '2026-10-12')).toBe(3);
    expect(dateRange('2026-10-12', '2026-10-10')).toEqual([]);
    expect(() => dateRange('2026-01-01', '2026-12-31', 10)).toThrow(RangeError);
    expect(dateRange('2026-02-28', '2026-03-01')).toEqual(['2026-02-28', '2026-03-01']);
  });

  it('adds days across month boundaries in UTC', () => {
    expect(toIso(addDays(new Date('2026-02-28T23:00:00.000Z'), 1))).toBe('2026-03-01T23:00:00.000Z');
    expect(differenceInSeconds(new Date('2026-03-01T00:00:30.000Z'), new Date('2026-03-01T00:00:00.000Z'))).toBe(30);
  });

  it('jitters deterministically and never below the minimum', () => {
    const rng = createRng(42);
    const values = [jitterSeconds(60, { rng }), jitterSeconds(60, { rng }), jitterSeconds(60, { rng })];
    // Spec § 12: 60 s ± 15 s
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(45);
      expect(value).toBeLessThanOrEqual(75);
    }
    expect(jitterSeconds(1, { ratio: 1, minSeconds: 1, rng: () => 0 })).toBe(1);
    // Same seed ⇒ same sequence (reproducible tests)
    expect(jitterSeconds(60, { rng: createRng(7) })).toBe(jitterSeconds(60, { rng: createRng(7) }));
  });

  it('computes exponential backoff with a cap', () => {
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(10);
    expect(backoffSeconds(3)).toBe(20);
    expect(backoffSeconds(20)).toBe(900);
    const jittered = backoffSeconds(3, { jitterRatio: 0.25, rng: createRng(1) });
    expect(jittered).toBeGreaterThanOrEqual(15);
    expect(jittered).toBeLessThanOrEqual(25);
  });

  it('parses ISO-8601 duration subsets used by configuration', () => {
    expect(parseDurationToSeconds('PT10M')).toBe(600);
    expect(parseDurationToSeconds('P1D')).toBe(86400);
    expect(parseDurationToSeconds('PT1H30M')).toBe(5400);
    expect(() => parseDurationToSeconds('10 minutes')).toThrow(RangeError);
  });
});
