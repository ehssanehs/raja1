/**
 * Pure quarantine ("rest") decision logic — the respectful counterpart to rotation.
 *
 * When the provider signals a restriction on an egress IP (429, block page, repeated CAPTCHA,
 * repeated auth failures), that proxy is put to rest for a window and its request budget is
 * tightened. It is NOT swapped for another IP so traffic can continue — that evasion pattern is
 * explicitly rejected (ADR-0008). Rest windows grow with repeated offences (exponential backoff,
 * capped), and a proxy is marked DEAD after sustained hard failures.
 */
import { PROXY_SETTINGS_LIMITS } from '@raja/shared';
import type { ProxyHealthSampleInput, QuarantineDecision } from './types';

export interface QuarantineStateInput {
  /** Current consecutive-failure counter of the proxy (before this sample). */
  consecutiveFailures: number;
  /** Current budget multiplier percent (100 = full budget). */
  currentMultiplierPct: number;
  /** How many times the proxy has been quarantined before (backoff base). */
  quarantineCount: number;
  /** Admin-defined base rest window in seconds (clamped to the platform bounds). */
  restSeconds?: number | null;
}

const DEFAULT_REST_SECONDS = PROXY_SETTINGS_LIMITS.DEFAULT_REST_SECONDS;
const CAP = PROXY_SETTINGS_LIMITS.MAX_REST_SECONDS;
const MAX_MULTIPLIER_PCT_DIVISOR = 8; // budget can shrink to 1/8 of configured, never further
const BUDGET_FLOOR_PCT = Math.floor(100 / MAX_MULTIPLIER_PCT_DIVISOR); // 12

/** Clamp an admin rest window into platform bounds. */
export function clampRestSeconds(restSeconds?: number | null): number {
  const value = restSeconds ?? DEFAULT_REST_SECONDS;
  return Math.min(Math.max(Math.round(value), PROXY_SETTINGS_LIMITS.MIN_REST_SECONDS), CAP);
}

/**
 * Exponential rest window: base × 2^min(offences, 4), capped at MAX_REST_SECONDS.
 * `offences` counts *previous* quarantines so first offence uses the base window.
 */
export function restWindowSeconds(baseSeconds: number, previousQuarantines: number): number {
  const backoffFactor = 2 ** Math.min(Math.max(previousQuarantines, 0), 4);
  return Math.min(Math.round(baseSeconds * backoffFactor), CAP);
}

/** Tightened request budget while resting/recovering (halves per offence, floors at 1/8). */
export function tightenedBudgetPercent(currentPct: number): number {
  return Math.max(Math.round(currentPct / 2), BUDGET_FLOOR_PCT);
}

/** Error classes that indicate the *egress itself* is restricted (not our payload, not the API). */
const RESTRICTED_CLASSES = new Set(['RATE_LIMIT']);

/**
 * Decide what a single health sample means for the proxy's availability.
 *
 * Quarantine triggers (any):
 *  - `RATE_LIMIT` failure class or HTTP 429 observed through the proxy
 *  - a provider block page
 *  - CAPTCHA challenges on >= 2 consecutive samples (the polite interpretation: this IP is being
 *    challenged; let it rest — never "solve and continue")
 *  - 3+ consecutive auth-ish failures (403/407), which usually mean the IP is denied
 *
 * Plain network errors/timeouts do NOT quarantine by themselves — the health score and the
 * consecutive-failure counter handle them (a flaky proxy is deprioritised, not rested).
 */
export function decideQuarantine(sample: ProxyHealthSampleInput, state: QuarantineStateInput, now: Date): QuarantineDecision {
  const baseRest = clampRestSeconds(state.restSeconds);
  const nextMultiplierPct = tightenedBudgetPercent(state.currentMultiplierPct);

  const rateLimited = sample.errorClass === 'RATE_LIMIT' || sample.httpStatus === 429;
  const blockPage = sample.blockPage === true;
  const captcha = sample.captchaSeen === true;
  const authish = sample.httpStatus === 403 || sample.httpStatus === 407 || sample.errorClass === 'AUTH';

  if (rateLimited) {
    const seconds = restWindowSeconds(baseRest * 2, state.quarantineCount);
    return { quarantine: true, until: new Date(now.getTime() + seconds * 1000), reason: 'RATE_LIMITED_BY_PROVIDER', multiplierPct: nextMultiplierPct };
  }
  if (blockPage) {
    const seconds = restWindowSeconds(baseRest * 2, state.quarantineCount);
    return { quarantine: true, until: new Date(now.getTime() + seconds * 1000), reason: 'PROVIDER_BLOCK_PAGE', multiplierPct: nextMultiplierPct };
  }
  if (captcha) {
    // One CAPTCHA may be incidental; two signal this IP is being challenged persistently.
    const escalated = state.consecutiveFailures >= 1;
    if (escalated) {
      const seconds = restWindowSeconds(baseRest * 2, state.quarantineCount);
      return { quarantine: true, until: new Date(now.getTime() + seconds * 1000), reason: 'REPEATED_CAPTCHA_CHALLENGES', multiplierPct: nextMultiplierPct };
    }
    return { quarantine: false, until: null, reason: 'CAPTCHA_OBSERVED_ONCE', multiplierPct: state.currentMultiplierPct };
  }
  if (!sample.ok && authish && state.consecutiveFailures + 1 >= 3) {
    const seconds = restWindowSeconds(baseRest, state.quarantineCount);
    return { quarantine: true, until: new Date(now.getTime() + seconds * 1000), reason: 'REPEATED_AUTH_FAILURES', multiplierPct: nextMultiplierPct };
  }
  if (!sample.ok && RESTRICTED_CLASSES.has(sample.errorClass ?? '')) {
    const seconds = restWindowSeconds(baseRest * 2, state.quarantineCount);
    return { quarantine: true, until: new Date(now.getTime() + seconds * 1000), reason: 'RATE_LIMITED_BY_PROVIDER', multiplierPct: nextMultiplierPct };
  }
  return { quarantine: false, until: null, reason: sample.ok ? 'HEALTHY' : 'TRANSIENT_FAILURE', multiplierPct: state.currentMultiplierPct };
}

/**
 * Health-score update for one sample. Probes move the score gently; real provider traffic is
 * weighted higher because it reflects the conditions that actually matter.
 */
export function nextHealthScore(current: number, sample: ProxyHealthSampleInput): number {
  let delta: number;
  if (sample.ok) {
    delta = sample.source === 'PROBE' ? 5 : 3;
  } else {
    delta = sample.source === 'PROBE' ? -12 : -18;
  }
  return Math.min(100, Math.max(0, current + delta));
}

/** True when sustained hard failures mean the proxy should be marked DEAD (needs admin attention). */
export function shouldMarkDead(consecutiveFailures: number, sample: ProxyHealthSampleInput): boolean {
  const hardFailure =
    !sample.ok &&
    (sample.errorClass === 'AUTH' || sample.httpStatus === 403 || sample.httpStatus === 407 || sample.blockPage === true);
  return hardFailure && consecutiveFailures >= PROXY_SETTINGS_LIMITS.DEAD_AFTER_CONSECUTIVE_FAILURES;
}
