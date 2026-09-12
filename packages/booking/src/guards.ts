/**
 * Booking submission guards (docs/booking-state-machine.md § 4) and the warm-up rule (§ 15).
 *
 * Eleven independent signals must line up before an irreversible provider call. They are evaluated
 * as a set so the denial reason can name *every* blocker at once, which is what an operator needs at
 * 08:29 during a release window.
 */
import { AppError, type AutomationMode, type MaintenanceMode, type Permission } from '@raja/shared';

export const SUBMISSION_GUARDS = [
  'dryRunOff',
  'providerApprovedAndCapable',
  'providerEnabledAndBreakerClosed',
  'globalAutoBookingEnabled',
  'modePermitsAction',
  'consentRecorded',
  'chargeAuthorized',
  'lockHeldWithFencingToken',
  'accountActive',
  'rateLimitTokenAcquired',
  'maintenanceOff',
] as const;

export type SubmissionGuard = (typeof SUBMISSION_GUARDS)[number];

export type ProviderAccountStatus = 'ACTIVE' | 'COOLDOWN' | 'QUARANTINED' | 'DISABLED';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SubmissionSignals {
  /** Guard 1 — a real submission never happens in dry-run. */
  dryRun: boolean;
  /** Guard 2 — compliance review + declared capability. */
  providerCompliance: 'APPROVED' | 'NOT_REVIEWED' | 'PROHIBITED';
  providerSupportsAutoBooking: boolean;
  /** Guard 3 — provider switch and circuit breaker. */
  providerEnabled: boolean;
  breakerState: BreakerState;
  /** Guard 4 — global kill switch (system setting / feature flag). */
  globalAutoBookingEnabled: boolean;
  /** Guard 5 — the request's automation mode. */
  automationMode: AutomationMode;
  /** Guard 6 — a versioned consent record exists for this action. */
  consentRecorded: boolean;
  /** Guard 7 — funded, unexpired charge authorization. */
  chargeAuthorized: boolean;
  /** Guard 8 — Redis lock + DB row lock with the current fencing token. */
  lockHeldWithFencingToken: boolean;
  /** Guard 9 — no quarantined accounts. */
  accountStatus: ProviderAccountStatus;
  /** Guard 10 — token acquired from every applicable bucket. */
  rateLimitTokenAcquired: boolean;
  /** Guard 11 — maintenance / booking-disabled mode. */
  maintenanceMode: MaintenanceMode;
}

export interface GuardOutcome {
  allowed: boolean;
  failures: SubmissionGuard[];
  details: Record<string, unknown>;
}

/** The action a signal set is being evaluated for (search is allowed in more situations). */
export type SubmissionAction = 'SEARCH' | 'RESERVE' | 'PAY';

export function evaluateSubmissionGuards(
  signals: SubmissionSignals,
  action: SubmissionAction = 'RESERVE',
): GuardOutcome {
  const failures: SubmissionGuard[] = [];
  const details: Record<string, unknown> = {};

  // Reads are allowed in dry-run, during maintenance-free operation, and for NOT_REVIEWED
  // providers — but never for a PROHIBITED one.
  if (action === 'SEARCH') {
    if (signals.providerCompliance === 'PROHIBITED') failures.push('providerApprovedAndCapable');
    if (!signals.providerEnabled) failures.push('providerEnabledAndBreakerClosed');
    if (signals.breakerState === 'OPEN') failures.push('providerEnabledAndBreakerClosed');
    if (signals.maintenanceMode !== 'NONE' && signals.maintenanceMode !== 'MONITORING_ONLY') {
      failures.push('maintenanceOff');
    }
    return { allowed: failures.length === 0, failures, details };
  }

  if (signals.dryRun) failures.push('dryRunOff');
  if (signals.providerCompliance !== 'APPROVED' || !signals.providerSupportsAutoBooking) {
    failures.push('providerApprovedAndCapable');
    details['compliance'] = signals.providerCompliance;
  }
  if (!signals.providerEnabled || signals.breakerState === 'OPEN') {
    failures.push('providerEnabledAndBreakerClosed');
    details['breaker'] = signals.breakerState;
  }
  if (!signals.globalAutoBookingEnabled) failures.push('globalAutoBookingEnabled');
  if (signals.automationMode === 'MONITOR_ONLY' || signals.automationMode === 'AUTO_FILL') {
    // AUTO_FILL fills forms but never submits an irreversible action.
    failures.push('modePermitsAction');
    details['automationMode'] = signals.automationMode;
  }
  if (action === 'PAY') {
    // Payment always needs a human or an explicitly authorised mode, and always a funded charge.
    if (!signals.consentRecorded) failures.push('consentRecorded');
    if (!signals.chargeAuthorized) failures.push('chargeAuthorized');
  } else {
    if (signals.automationMode === 'AUTO_HOLD' || signals.automationMode === 'AUTHORIZED_AUTO_BOOKING') {
      if (!signals.consentRecorded) failures.push('consentRecorded');
      if (!signals.chargeAuthorized) failures.push('chargeAuthorized');
    } else if (!signals.chargeAuthorized) {
      // Even without automation, reserving a seat needs an authorization to be funded.
      failures.push('chargeAuthorized');
    }
  }
  if (!signals.lockHeldWithFencingToken) failures.push('lockHeldWithFencingToken');
  if (signals.accountStatus !== 'ACTIVE') {
    failures.push('accountActive');
    details['accountStatus'] = signals.accountStatus;
  }
  if (!signals.rateLimitTokenAcquired) failures.push('rateLimitTokenAcquired');
  if (signals.maintenanceMode !== 'NONE' && signals.maintenanceMode !== 'MONITORING_ONLY') {
    failures.push('maintenanceOff');
    details['maintenanceMode'] = signals.maintenanceMode;
  }

  return { allowed: failures.length === 0, failures, details };
}

export interface SubmissionDenialContext {
  bookingRequestId: string;
  permission?: Permission;
}

/**
 * Fail-closed assertion used by the orchestrator. Throws `COMPLIANCE_BLOCKED` in dry-run (that is
 * the *expected* outcome of a dry-run submission and is surfaced as such to the user) and
 * `FORBIDDEN` otherwise, both carrying the full failure list.
 */
export function assertSubmissionAllowed(
  signals: SubmissionSignals,
  action: SubmissionAction = 'RESERVE',
  denied?: SubmissionDenialContext,
): GuardOutcome {
  const outcome = evaluateSubmissionGuards(signals, action);
  if (outcome.allowed) return outcome;

  const code = outcome.failures.includes('dryRunOff') ? 'DRY_RUN_BLOCKED' : 'FORBIDDEN';
  throw new AppError(
    code,
    code === 'DRY_RUN_BLOCKED'
      ? 'dry-run mode blocked an irreversible provider action'
      : `booking submission blocked by guards: ${outcome.failures.join(', ')}`,
    {
      userMessageKey: code === 'DRY_RUN_BLOCKED' ? 'error.dry_run_blocked' : 'error.forbidden',
      details: { ...outcome.details, failures: outcome.failures, ...denied },
    },
  );
}

/** Purposes that may observe a provider but must never change anything on it. */
export const READ_ONLY_PURPOSES = ['WARMUP', 'BURST_VALIDATION', 'SEARCH', 'STATUS'] as const;
export type CallPurpose = (typeof READ_ONLY_PURPOSES)[number] | 'BOOKING';

/**
 * Warm-up and burst validation exist to make the *session* ready and to measure the released
 * inventory. They are a hard read-only path: this function is called by the scheduler before it
 * hands work to the orchestrator, and by the orchestrator before any write. Tested by
 * `warmup-no-booking.spec.ts`.
 */
export function assertWarmupNeverBooks(purpose: CallPurpose, operation: 'READ' | 'WRITE' | 'AUTOMATION'): void {
  if (operation === 'READ') return;
  if (purpose === 'WARMUP' || purpose === 'BURST_VALIDATION') {
    throw new AppError(
      'FORBIDDEN',
      `${purpose.toLowerCase()} calls are read-only and must never perform a ${operation} operation`,
      {
        userMessageKey: 'error.forbidden',
        details: { purpose, operation },
      },
    );
  }
}

export function isReadOnlyPurpose(purpose: CallPurpose): boolean {
  return purpose !== 'BOOKING';
}
