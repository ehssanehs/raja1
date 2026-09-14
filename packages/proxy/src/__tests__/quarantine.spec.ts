/**
 * Quarantine ("rest") semantics: provider restriction signals must lead to rest for the affected
 * proxy — never to a fresh IP. Windows grow with repeat offences; budgets tighten; DEAD is the
 * terminal state for sustained hard failures.
 */
import { describe, expect, it } from 'vitest';
import { clampRestSeconds, decideQuarantine, nextHealthScore, restWindowSeconds, shouldMarkDead, tightenedBudgetPercent } from '../quarantine';
import { PROXY_SETTINGS_LIMITS } from '@raja/shared';

const NOW = new Date('2026-09-12T10:00:00Z');
const baseState = { consecutiveFailures: 0, currentMultiplierPct: 100, quarantineCount: 0, restSeconds: 900 };

describe('quarantine decisions', () => {
  it('quarantines on HTTP 429 observed through the proxy', () => {
    const decision = decideQuarantine({ ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' }, baseState, NOW);
    expect(decision.quarantine).toBe(true);
    expect(decision.reason).toBe('RATE_LIMITED_BY_PROVIDER');
    expect(decision.until!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('quarantines on a provider block page', () => {
    const decision = decideQuarantine({ ok: false, source: 'TRAFFIC', httpStatus: 200, blockPage: true }, baseState, NOW);
    expect(decision.quarantine).toBe(true);
    expect(decision.reason).toBe('PROVIDER_BLOCK_PAGE');
  });

  it('treats a single CAPTCHA as incidental but repeated CAPTCHAs as rest', () => {
    const first = decideQuarantine({ ok: true, source: 'TRAFFIC', captchaSeen: true }, baseState, NOW);
    expect(first.quarantine).toBe(false);

    const repeated = decideQuarantine({ ok: true, source: 'TRAFFIC', captchaSeen: true }, { ...baseState, consecutiveFailures: 1 }, NOW);
    expect(repeated.quarantine).toBe(true);
    expect(repeated.reason).toBe('REPEATED_CAPTCHA_CHALLENGES');
  });

  it('quarantines after repeated auth failures (403/407) but not after one', () => {
    const one = decideQuarantine({ ok: false, source: 'TRAFFIC', httpStatus: 403, errorClass: 'AUTH' }, baseState, NOW);
    expect(one.quarantine).toBe(false);

    const repeated = decideQuarantine(
      { ok: false, source: 'TRAFFIC', httpStatus: 403, errorClass: 'AUTH' },
      { ...baseState, consecutiveFailures: 2 },
      NOW,
    );
    expect(repeated.quarantine).toBe(true);
    expect(repeated.reason).toBe('REPEATED_AUTH_FAILURES');
  });

  it('does NOT quarantine plain network errors/timeouts — they only dent the health score', () => {
    const timeout = decideQuarantine({ ok: false, source: 'TRAFFIC', errorClass: 'TIMEOUT' }, baseState, NOW);
    expect(timeout.quarantine).toBe(false);
    const network = decideQuarantine({ ok: false, source: 'PROBE', errorClass: 'NETWORK' }, baseState, NOW);
    expect(network.quarantine).toBe(false);
  });

  it('grows the rest window exponentially with repeat offences (capped)', () => {
    const first = restWindowSeconds(900, 0);
    const second = restWindowSeconds(900, 1);
    const third = restWindowSeconds(900, 2);
    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
    expect(restWindowSeconds(900, 10)).toBeLessThanOrEqual(PROXY_SETTINGS_LIMITS.MAX_REST_SECONDS);
  });

  it('tightens the request budget on each offence and floors at 1/8', () => {
    expect(tightenedBudgetPercent(100)).toBe(50);
    expect(tightenedBudgetPercent(50)).toBe(25);
    expect(tightenedBudgetPercent(25)).toBe(13);
    expect(tightenedBudgetPercent(12)).toBe(12);
  });

  it('marks a proxy DEAD only after sustained *hard* failures', () => {
    expect(shouldMarkDead(2, { ok: false, source: 'TRAFFIC', httpStatus: 403, errorClass: 'AUTH' })).toBe(false);
    expect(shouldMarkDead(5, { ok: false, source: 'TRAFFIC', httpStatus: 403, errorClass: 'AUTH' })).toBe(true);
    expect(shouldMarkDead(50, { ok: false, source: 'PROBE', errorClass: 'TIMEOUT' })).toBe(false);
  });

  it('keeps admin rest windows inside platform bounds', () => {
    expect(clampRestSeconds(1)).toBe(PROXY_SETTINGS_LIMITS.MIN_REST_SECONDS);
    expect(clampRestSeconds(999_999)).toBe(PROXY_SETTINGS_LIMITS.MAX_REST_SECONDS);
    expect(clampRestSeconds(null)).toBe(PROXY_SETTINGS_LIMITS.DEFAULT_REST_SECONDS);
  });

  it('moves the health score gently on probes and harder on real traffic', () => {
    expect(nextHealthScore(50, { ok: true, source: 'PROBE' })).toBe(55);
    expect(nextHealthScore(50, { ok: true, source: 'TRAFFIC' })).toBe(53);
    expect(nextHealthScore(50, { ok: false, source: 'PROBE' })).toBe(38);
    expect(nextHealthScore(50, { ok: false, source: 'TRAFFIC' })).toBe(32);
    expect(nextHealthScore(99, { ok: true, source: 'PROBE' })).toBe(100);
    expect(nextHealthScore(2, { ok: false, source: 'TRAFFIC' })).toBe(0);
  });
});
