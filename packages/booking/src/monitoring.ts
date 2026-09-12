/**
 * Monitoring strategies (spec § 13, docs/scheduler.md § 3).
 *
 * A monitor's next search is computed here — never by ad-hoc arithmetic inside the scheduler — so
 * the "why did it search now?" question always has one answer. All strategies respect the hard
 * floor from plan limits and the global minimum (`LIMITS.MIN_MONITOR_INTERVAL_SECONDS`).
 *
 * Defaults are documented in docs/scheduler.md; jitter, backoff and the burst offsets come from
 * `@raja/shared` so the API, the scheduler and the tests cannot disagree.
 */

import {
  LIMITS,
  MONITORING_STRATEGIES,
  backoffSeconds,
  jitterSeconds,
  type MonitoringStrategy,
  type QueueLevel,
} from '@raja/shared';

export interface MonitorState {
  strategy: MonitoringStrategy;
  /** Base interval from plan entitlement / request settings, in seconds. */
  baseIntervalSeconds: number;
  /** Hard floor for this plan (never go below). */
  minIntervalSeconds: number;
  /** Consecutive searches without a match. */
  consecutiveMisses: number;
  /** Priority bucket of the request (1 = highest). */
  priority: number;
  /** Number of 429/Retry-After responses seen recently. */
  throttleEvents: number;
  /** Absolute time of the release window start, when the request targets one. */
  releaseAt?: Date | null;
  /** Queue level, used by PRIORITY_BASED. */
  queueLevel?: QueueLevel;
}

export interface NextSearchInput {
  state: MonitorState;
  now: Date;
  /** Random source (injectable for deterministic tests). */
  random?: () => number;
}

/** Retry-After policy: the provider slowed us down, everyone slows down. */
export const THROTTLE_BACKOFF_FACTOR = 2;
export const THROTTLE_MAX_INTERVAL_SECONDS = 900;

export function effectiveIntervalSeconds(state: MonitorState, now: Date): number {
  const floor = Math.max(state.minIntervalSeconds, LIMITS.MIN_MONITOR_INTERVAL_SECONDS);
  const base = Math.max(state.baseIntervalSeconds, floor);

  switch (state.strategy) {
    case 'FIXED':
      return base;

    case 'JITTERED':
      // Jitter is applied exactly once — when the next search is actually scheduled — so a monitor
      // can never be jittered twice (once by the strategy, once by the scheduler) and drift into a
      // cadence nobody configured. The strategy only declares the *nominal* cadence.
      return base;

    case 'PRIORITY_BASED': {
      // Higher priority (lower number) searches more often: p1 → base/2, p3 → base, p5 → base*1.5.
      const factor = state.priority <= 2 ? 0.5 * state.priority : 1 + (state.priority - 3) * 0.25;
      return Math.max(floor, Math.round(base * factor));
    }

    case 'EXPONENTIAL_BACKOFF':
      return Math.max(floor, backoffSeconds(state.consecutiveMisses, { baseSeconds: base }));

    case 'RELEASE_TIME': {
      if (!state.releaseAt) return Math.max(floor, base);
      const millisToRelease = state.releaseAt.getTime() - now.getTime();
      // Far from release: normal cadence. Inside the last minute: tighten gradually, but never
      // below the floor — the release burst is handled by the burst validator, not by hammering.
      if (millisToRelease > 60_000) return Math.max(floor, base);
      if (millisToRelease <= 0) return floor;
      return Math.max(floor, Math.min(base, Math.ceil(millisToRelease / 60_000) + 1));
    }

    case 'ADAPTIVE': {
      // Learn from the observed miss rate: fast when the corridor changes often, calm when stable.
      const missRatio = Math.min(1, state.consecutiveMisses / 10);
      const adaptive = base * (1 + missRatio);
      return Math.max(floor, Math.round(adaptive));
    }

    default:
      return base;
  }
}

/** Throttled monitors are slowed down regardless of their strategy. */
export function throttledIntervalSeconds(state: MonitorState, interval: number): number {
  if (state.throttleEvents <= 0) return interval;
  const slowed = interval * THROTTLE_BACKOFF_FACTOR ** Math.min(state.throttleEvents, 6);
  return Math.min(THROTTLE_MAX_INTERVAL_SECONDS, Math.max(interval, Math.round(slowed)));
}

export function nextSearchAt(input: NextSearchInput): Date {
  const random = input.random ?? Math.random;
  const state = input.state;
  const floor = Math.max(state.minIntervalSeconds, LIMITS.MIN_MONITOR_INTERVAL_SECONDS);
  const nominal = throttledIntervalSeconds(state, effectiveIntervalSeconds(state, input.now));
  // Jitter the *scheduling* so two monitors created at the same time never sync up: the actual
  // interval is spread ±ratio around the nominal cadence.
  const jittered = jitterSeconds(nominal, { ratio: LIMITS.DEFAULT_JITTER_RATIO, rng: random });
  // Two lower bounds the jitter may never cross: the plan/global floor, and — for a monitor the
  // provider just throttled — the slowed-down cadence itself (a throttled monitor may only search
  // later than nominal, never earlier).
  const lowerBound = state.throttleEvents > 0 ? Math.max(floor, nominal) : floor;
  const scheduled = Math.max(lowerBound, jittered);
  return new Date(input.now.getTime() + scheduled * 1000);
}

/**
 * High-demand release timing (spec § 14–15, docs/high-demand-mode.md).
 *
 * The warm-up burst starts `search_start_offset_ms` *before* the announced release time (the
 * provider's own clock drifts). Validation offsets [0, +3, +10] seconds confirm whether the burst
 * actually produced availability; they never book.
 */
export const BURST_VALIDATION_OFFSETS_SECONDS = [0, 3, 10] as const;

export interface ReleaseWindow {
  releaseAt: Date;
  searchStartOffsetMs: number;
  warmupMinutesBefore: number;
  burstDurationSeconds: number;
  burstIntervalSeconds: number;
  capacityMaxJobs: number;
  safetyMargin: number;
}

export function warmupStartAt(window: Pick<ReleaseWindow, 'releaseAt' | 'searchStartOffsetMs' | 'warmupMinutesBefore'>): Date {
  const burstStart = window.releaseAt.getTime() + window.searchStartOffsetMs;
  return new Date(burstStart - window.warmupMinutesBefore * 60_000);
}

export function burstStartAt(window: Pick<ReleaseWindow, 'releaseAt' | 'searchStartOffsetMs'>): Date {
  return new Date(window.releaseAt.getTime() + window.searchStartOffsetMs);
}

export function burstEndAt(window: Pick<ReleaseWindow, 'releaseAt' | 'searchStartOffsetMs' | 'burstDurationSeconds'>): Date {
  return new Date(window.releaseAt.getTime() + window.searchStartOffsetMs + window.burstDurationSeconds * 1000);
}

export function validationTimes(window: Pick<ReleaseWindow, 'releaseAt'>): Date[] {
  return BURST_VALIDATION_OFFSETS_SECONDS.map((offset) => new Date(window.releaseAt.getTime() + offset * 1000));
}

/**
 * Admission control (docs/high-demand-mode.md § 4):
 *   admitted = floor(capacity_max_jobs * safety_margin) - already_admitted
 * ordinary monitoring is never starved: tenants without an admission keep their normal cadence.
 */
export function admissionCapacity(window: Pick<ReleaseWindow, 'capacityMaxJobs' | 'safetyMargin'>, alreadyAdmitted: number): number {
  const safe = Math.floor(window.capacityMaxJobs * window.safetyMargin);
  return Math.max(0, safe - alreadyAdmitted);
}

export function isBurstIntervalAllowed(window: Pick<ReleaseWindow, 'burstIntervalSeconds'>): boolean {
  return window.burstIntervalSeconds >= 1;
}

export function describeStrategy(strategy: MonitoringStrategy): string {
  switch (strategy) {
    case 'FIXED':
      return 'searches at a constant interval';
    case 'JITTERED':
      return 'constant interval plus ±25% jitter to avoid synchronised bursts';
    case 'PRIORITY_BASED':
      return 'high-priority requests search more often';
    case 'EXPONENTIAL_BACKOFF':
      return 'backs off after consecutive misses, resets on availability';
    case 'RELEASE_TIME':
      return 'tightens the cadence as a known release time approaches';
    case 'ADAPTIVE':
      return 'adapts to the observed rate of change on the corridor';
    default:
      return String(strategy);
  }
}

export function isMonitoringStrategy(value: unknown): value is MonitoringStrategy {
  return typeof value === 'string' && (MONITORING_STRATEGIES as readonly string[]).includes(value);
}
