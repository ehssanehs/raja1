/**
 * Submission guards (docs/booking-state-machine.md § 4, spec § 16, § 22).
 *
 * Every irreversible provider action is gated by eleven independent signals. The tests below pin the
 * two properties that matter most in production:
 *   1. fail-closed — one missing signal is enough to block;
 *   2. dry-run is *never* a real submission, and the denial says so explicitly so the UI can explain
 *      it instead of looking broken.
 */
import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_GUARDS,
  assertSubmissionAllowed,
  evaluateSubmissionGuards,
  type SubmissionSignals,
} from '../guards';

/** The "everything is in order" signal set used as the baseline for negative tests. */
function signals(overrides: Partial<SubmissionSignals> = {}): SubmissionSignals {
  return {
    dryRun: false,
    providerCompliance: 'APPROVED',
    providerSupportsAutoBooking: true,
    providerEnabled: true,
    breakerState: 'CLOSED',
    globalAutoBookingEnabled: true,
    automationMode: 'AUTHORIZED_AUTO_BOOKING',
    consentRecorded: true,
    chargeAuthorized: true,
    lockHeldWithFencingToken: true,
    accountStatus: 'ACTIVE',
    rateLimitTokenAcquired: true,
    maintenanceMode: 'NONE',
    ...overrides,
  };
}

describe('guard set', () => {
  it('declares all eleven guards', () => {
    expect(SUBMISSION_GUARDS).toHaveLength(11);
    expect(new Set(SUBMISSION_GUARDS).size).toBe(11);
  });

  it('allows a fully authorised auto-booking', () => {
    expect(evaluateSubmissionGuards(signals(), 'RESERVE')).toEqual({ allowed: true, failures: [], details: {} });
  });

  it('is fail-closed: each single missing signal blocks on its own', () => {
    const negatives: Array<[Partial<SubmissionSignals>, string]> = [
      [{ dryRun: true }, 'dryRunOff'],
      [{ providerCompliance: 'NOT_REVIEWED' }, 'providerApprovedAndCapable'],
      [{ providerSupportsAutoBooking: false }, 'providerApprovedAndCapable'],
      [{ providerEnabled: false }, 'providerEnabledAndBreakerClosed'],
      [{ breakerState: 'OPEN' }, 'providerEnabledAndBreakerClosed'],
      [{ globalAutoBookingEnabled: false }, 'globalAutoBookingEnabled'],
      [{ automationMode: 'MONITOR_ONLY' }, 'modePermitsAction'],
      [{ automationMode: 'AUTO_FILL' }, 'modePermitsAction'],
      [{ consentRecorded: false }, 'consentRecorded'],
      [{ chargeAuthorized: false }, 'chargeAuthorized'],
      [{ lockHeldWithFencingToken: false }, 'lockHeldWithFencingToken'],
      [{ accountStatus: 'QUARANTINED' }, 'accountActive'],
      [{ accountStatus: 'COOLDOWN' }, 'accountActive'],
      [{ rateLimitTokenAcquired: false }, 'rateLimitTokenAcquired'],
      [{ maintenanceMode: 'BOOKING_DISABLED' }, 'maintenanceOff'],
      [{ maintenanceMode: 'FULL' }, 'maintenanceOff'],
    ];

    for (const [override, expected] of negatives) {
      const outcome = evaluateSubmissionGuards(signals(override), 'RESERVE');
      expect(outcome.allowed, JSON.stringify(override)).toBe(false);
      expect(outcome.failures, JSON.stringify(override)).toContain(expected);
    }
  });

  it('reports every blocking guard at once, so an operator sees the whole picture', () => {
    const outcome = evaluateSubmissionGuards(
      signals({ dryRun: true, chargeAuthorized: false, accountStatus: 'QUARANTINED', maintenanceMode: 'FULL' }),
      'RESERVE',
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.failures).toEqual(
      expect.arrayContaining(['dryRunOff', 'chargeAuthorized', 'accountActive', 'maintenanceOff']),
    );
    expect(outcome.details).toMatchObject({ accountStatus: 'QUARANTINED', maintenanceMode: 'FULL' });
  });
});

describe('automation modes', () => {
  it('AUTO_HOLD needs consent and a funded charge but not a mode exception', () => {
    const hold = signals({ automationMode: 'AUTO_HOLD' });
    expect(evaluateSubmissionGuards(hold, 'RESERVE').allowed).toBe(true);
    expect(evaluateSubmissionGuards({ ...hold, consentRecorded: false }, 'RESERVE').failures).toContain('consentRecorded');
    expect(evaluateSubmissionGuards({ ...hold, chargeAuthorized: false }, 'RESERVE').failures).toContain(
      'chargeAuthorized',
    );
  });

  it('MONITOR_ONLY and AUTO_FILL may never reserve, even with everything else perfect', () => {
    expect(evaluateSubmissionGuards(signals({ automationMode: 'MONITOR_ONLY' }), 'RESERVE').failures).toContain(
      'modePermitsAction',
    );
    expect(evaluateSubmissionGuards(signals({ automationMode: 'AUTO_FILL' }), 'RESERVE').failures).toContain(
      'modePermitsAction',
    );
  });

  it('payment always requires consent, whatever the mode', () => {
    const outcome = evaluateSubmissionGuards(signals({ automationMode: 'AUTO_HOLD', consentRecorded: false }), 'PAY');
    expect(outcome.allowed).toBe(false);
    expect(outcome.failures).toContain('consentRecorded');
  });
});

describe('searches', () => {
  it('allows a dry-run search against a NOT_REVIEWED provider (research is allowed)', () => {
    const outcome = evaluateSubmissionGuards(
      signals({ dryRun: true, providerCompliance: 'NOT_REVIEWED', providerSupportsAutoBooking: false, automationMode: 'MONITOR_ONLY' }),
      'SEARCH',
    );
    expect(outcome.allowed).toBe(true);
  });

  it('always refuses a PROHIBITED provider, even for a search', () => {
    const outcome = evaluateSubmissionGuards(signals({ providerCompliance: 'PROHIBITED' }), 'SEARCH');
    expect(outcome.allowed).toBe(false);
    expect(outcome.failures).toEqual(['providerApprovedAndCapable']);
  });

  it('refuses searches while the breaker is open or the provider is disabled', () => {
    expect(evaluateSubmissionGuards(signals({ breakerState: 'OPEN' }), 'SEARCH').failures).toContain(
      'providerEnabledAndBreakerClosed',
    );
    expect(evaluateSubmissionGuards(signals({ providerEnabled: false }), 'SEARCH').failures).toContain(
      'providerEnabledAndBreakerClosed',
    );
  });

  it('refuses searches in a full maintenance mode but permits MONITORING_ONLY', () => {
    expect(evaluateSubmissionGuards(signals({ maintenanceMode: 'FULL' }), 'SEARCH').allowed).toBe(false);
    expect(evaluateSubmissionGuards(signals({ maintenanceMode: 'MONITORING_ONLY' }), 'SEARCH').allowed).toBe(true);
  });
});

describe('assertions', () => {
  it('throws DRY_RUN_BLOCKED (not FORBIDDEN) when the only blocker is dry-run', () => {
    try {
      assertSubmissionAllowed(signals({ dryRun: true }), 'RESERVE', { bookingRequestId: 'req-1' });
      throw new Error('expected the guard to throw');
    } catch (error) {
      const appError = error as { code?: string; message?: string; details?: Record<string, unknown> };
      expect(appError.code).toBe('DRY_RUN_BLOCKED');
      expect(appError.message).toMatch(/dry-run/i);
      expect(appError.details).toMatchObject({ failures: ['dryRunOff'], bookingRequestId: 'req-1' });
    }
  });

  it('throws FORBIDDEN and names every blocker otherwise', () => {
    try {
      assertSubmissionAllowed(signals({ chargeAuthorized: false, accountStatus: 'QUARANTINED' }), 'RESERVE');
      throw new Error('expected the guard to throw');
    } catch (error) {
      const appError = error as { code?: string; message?: string; details?: Record<string, unknown> };
      expect(appError.code).toBe('FORBIDDEN');
      expect(appError.message).toMatch(/chargeAuthorized/);
      expect(appError.message).toMatch(/accountActive/);
      expect(appError.details?.['failures']).toEqual(expect.arrayContaining(['chargeAuthorized', 'accountActive']));
    }
  });

  it('returns the outcome when nothing blocks', () => {
    const outcome = assertSubmissionAllowed(signals(), 'RESERVE');
    expect(outcome.allowed).toBe(true);
  });
});
