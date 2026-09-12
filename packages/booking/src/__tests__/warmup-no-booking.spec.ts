/**
 * Warm-up and burst validation must never book (spec § 15, docs/high-demand-mode.md § 3).
 *
 * This is one of the safety-critical rules of the platform: during a release window the platform
 * deliberately sends more traffic than usual, and the temptation to "just grab a seat during
 * warm-up" is exactly what the policy forbids. These tests are named in docs/threat-model.md
 * (TM-23) and are required to pass before high-demand mode may be enabled.
 */
import { describe, expect, it } from 'vitest';
import {
  BURST_VALIDATION_OFFSETS_SECONDS,
  admissionCapacity,
  burstEndAt,
  burstStartAt,
  describeStrategy,
  effectiveIntervalSeconds,
  isBurstIntervalAllowed,
  nextSearchAt,
  throttledIntervalSeconds,
  validationTimes,
  warmupStartAt,
  type MonitorState,
  type ReleaseWindow,
} from '../monitoring';
import { READ_ONLY_PURPOSES, assertWarmupNeverBooks, isReadOnlyPurpose } from '../guards';

const window: ReleaseWindow = {
  releaseAt: new Date('2026-03-01T08:30:00.000Z'),
  searchStartOffsetMs: -10_000,
  warmupMinutesBefore: 40,
  burstDurationSeconds: 120,
  burstIntervalSeconds: 3,
  capacityMaxJobs: 400,
  safetyMargin: 0.8,
};

describe('read-only purposes', () => {
  it('lists warm-up and burst validation among the read-only purposes', () => {
    expect(READ_ONLY_PURPOSES).toContain('WARMUP');
    expect(READ_ONLY_PURPOSES).toContain('BURST_VALIDATION');
    expect(isReadOnlyPurpose('WARMUP')).toBe(true);
    expect(isReadOnlyPurpose('BURST_VALIDATION')).toBe(true);
    expect(isReadOnlyPurpose('BOOKING')).toBe(false);
  });

  it('allows reads', () => {
    for (const purpose of READ_ONLY_PURPOSES) {
      expect(() => assertWarmupNeverBooks(purpose, 'READ')).not.toThrow();
    }
  });

  it('refuses writes and automation — for every read-only purpose, every time', () => {
    for (const purpose of ['WARMUP', 'BURST_VALIDATION'] as const) {
      for (const operation of ['WRITE', 'AUTOMATION'] as const) {
        expect(() => assertWarmupNeverBooks(purpose, operation), `${purpose}/${operation}`).toThrowError(
          /read-only|never/i,
        );
      }
    }
  });

  it('reports the offending purpose and operation in the error details', () => {
    try {
      assertWarmupNeverBooks('BURST_VALIDATION', 'AUTOMATION');
      throw new Error('should have thrown');
    } catch (error) {
      const appError = error as { code?: string; details?: Record<string, unknown> };
      expect(appError.code).toBe('FORBIDDEN');
      expect(appError.details).toMatchObject({ purpose: 'BURST_VALIDATION', operation: 'AUTOMATION' });
    }
  });

  it('lets a booking call through (the guard only constrains read-only purposes)', () => {
    expect(() => assertWarmupNeverBooks('BOOKING', 'WRITE')).not.toThrow();
    expect(() => assertWarmupNeverBooks('BOOKING', 'AUTOMATION')).not.toThrow();
  });
});

describe('release window timing', () => {
  it('starts warm-up 40 minutes before the burst', () => {
    expect(warmupStartAt(window).toISOString()).toBe('2026-03-01T07:49:50.000Z');
  });

  it('starts the burst 10 seconds before the announced release', () => {
    expect(burstStartAt(window).toISOString()).toBe('2026-03-01T08:29:50.000Z');
  });

  it('ends the burst after the configured duration', () => {
    expect(burstEndAt(window).toISOString()).toBe('2026-03-01T08:31:50.000Z');
  });

  it('validates the burst at 0, +3 and +10 seconds', () => {
    expect(BURST_VALIDATION_OFFSETS_SECONDS).toEqual([0, 3, 10]);
    expect(validationTimes(window).map((date) => date.toISOString())).toEqual([
      '2026-03-01T08:30:00.000Z',
      '2026-03-01T08:30:03.000Z',
      '2026-03-01T08:30:10.000Z',
    ]);
  });

  it('refuses a sub-second burst interval (which would be a hammer, not a burst)', () => {
    expect(isBurstIntervalAllowed(window)).toBe(true);
    expect(isBurstIntervalAllowed({ burstIntervalSeconds: 0 })).toBe(false);
  });
});

describe('admission control', () => {
  it('admits only up to capacity × safety margin', () => {
    expect(admissionCapacity(window, 0)).toBe(320);
    expect(admissionCapacity(window, 319)).toBe(1);
    expect(admissionCapacity(window, 320)).toBe(0);
    expect(admissionCapacity(window, 10_000)).toBe(0);
  });
});

describe('monitoring strategies', () => {
  const base: MonitorState = {
    strategy: 'FIXED',
    baseIntervalSeconds: 60,
    minIntervalSeconds: 30,
    consecutiveMisses: 0,
    priority: 3,
    throttleEvents: 0,
  };
  const now = new Date('2026-03-01T08:00:00.000Z');

  it('FIXED returns exactly the base interval', () => {
    expect(effectiveIntervalSeconds({ ...base, strategy: 'FIXED' }, now)).toBe(60);
  });

  it('JITTERED declares the nominal cadence and is jittered once, at scheduling time', () => {
    const jittered: MonitorState = { ...base, strategy: 'JITTERED' };
    expect(effectiveIntervalSeconds(jittered, now)).toBe(60);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const seconds = (nextSearchAt({ state: jittered, now }).getTime() - now.getTime()) / 1000;
      expect(seconds).toBeGreaterThanOrEqual(45);
      expect(seconds).toBeLessThanOrEqual(75);
    }
  });

  it('clamps jitter to the plan floor (a fast plan may not jitter below its own minimum)', () => {
    const capped: MonitorState = { ...base, strategy: 'JITTERED', minIntervalSeconds: 55 };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const seconds = (nextSearchAt({ state: capped, now, random: () => 0 }).getTime() - now.getTime()) / 1000;
      expect(seconds).toBe(55);
    }
  });

  it('never goes below the plan floor, whatever the strategy asks', () => {
    const floor = { ...base, minIntervalSeconds: 300 };
    expect(effectiveIntervalSeconds({ ...floor, strategy: 'FIXED' }, now)).toBe(300);
    expect(effectiveIntervalSeconds({ ...floor, strategy: 'PRIORITY_BASED', priority: 1 }, now)).toBe(300);
    const releaseSoon = { ...floor, strategy: 'RELEASE_TIME' as const, releaseAt: new Date(now.getTime() + 5_000) };
    expect(effectiveIntervalSeconds(releaseSoon, now)).toBe(300);
  });

  it('PRIORITY_BASED searches more often for higher priorities', () => {
    const p1 = effectiveIntervalSeconds({ ...base, strategy: 'PRIORITY_BASED', priority: 1 }, now);
    const p3 = effectiveIntervalSeconds({ ...base, strategy: 'PRIORITY_BASED', priority: 3 }, now);
    const p5 = effectiveIntervalSeconds({ ...base, strategy: 'PRIORITY_BASED', priority: 5 }, now);
    expect(p1).toBeLessThan(p3);
    expect(p3).toBeLessThan(p5);
  });

  it('EXPONENTIAL_BACKOFF grows and is capped', () => {
    const first = effectiveIntervalSeconds({ ...base, strategy: 'EXPONENTIAL_BACKOFF', consecutiveMisses: 1 }, now);
    const fifth = effectiveIntervalSeconds({ ...base, strategy: 'EXPONENTIAL_BACKOFF', consecutiveMisses: 5 }, now);
    const twentieth = effectiveIntervalSeconds({ ...base, strategy: 'EXPONENTIAL_BACKOFF', consecutiveMisses: 20 }, now);
    expect(first).toBe(60);
    expect(fifth).toBeGreaterThan(first);
    expect(twentieth).toBeLessThanOrEqual(900);
  });

  it('RELEASE_TIME keeps the base cadence far from the release and tightens near it', () => {
    const far = effectiveIntervalSeconds(
      { ...base, strategy: 'RELEASE_TIME', releaseAt: new Date(now.getTime() + 3_600_000) },
      now,
    );
    const near = effectiveIntervalSeconds(
      { ...base, strategy: 'RELEASE_TIME', releaseAt: new Date(now.getTime() + 30_000) },
      now,
    );
    expect(far).toBe(60);
    expect(near).toBeLessThanOrEqual(far);
    expect(near).toBeGreaterThanOrEqual(30);
  });

  it('slows down when the provider throttles us (Retry-After handling)', () => {
    const throttled = throttledIntervalSeconds({ ...base, throttleEvents: 2 }, 60);
    expect(throttled).toBeGreaterThan(60);
    expect(throttledIntervalSeconds({ ...base, throttleEvents: 99 }, 60)).toBeLessThanOrEqual(900);
    // No throttle events ⇒ no change.
    expect(throttledIntervalSeconds(base, 60)).toBe(60);
  });

  it('schedules the next search in the future, with jitter but above the floor', () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const next = nextSearchAt({ state: { ...base, strategy: 'JITTERED' }, now });
      expect(next.getTime()).toBeGreaterThan(now.getTime());
      const seconds = (next.getTime() - now.getTime()) / 1000;
      expect(seconds).toBeGreaterThanOrEqual(45);
      expect(seconds).toBeLessThanOrEqual(75);
    }
  });

  it('describes every strategy for the UI', () => {
    for (const strategy of ['FIXED', 'JITTERED', 'PRIORITY_BASED', 'EXPONENTIAL_BACKOFF', 'RELEASE_TIME', 'ADAPTIVE'] as const) {
      expect(describeStrategy(strategy)).not.toBe(strategy);
    }
  });
});
