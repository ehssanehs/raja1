/**
 * The booking state machine — the single authority on legal status changes
 * (docs/booking-state-machine.md is the specification; this file must stay in sync).
 *
 * Two rules make this more than documentation:
 *
 *  1. `assertTransition` is the only way the booking row's `status` may change. Services call it
 *     before writing; the write itself goes through `BookingService.transition`, which also appends
 *     the `booking_transitions` and `booking_timeline_events` rows in the same transaction.
 *  2. Every invariant in § 2 of the document is checked here (`checkInvariants`), so a bug that
 *     would produce an illegal history fails in tests instead of in production.
 */
import { AppError, BOOKING_STATES, conflict, isTerminalBookingState, type BookingState } from '@raja/shared';

export type TransitionTrigger =
  | 'submit'
  | 'validated'
  | 'validationFailed'
  | 'admitted'
  | 'tick'
  | 'noMatch'
  | 'match'
  | 'lock'
  | 'submitReservation'
  | 'verificationDetected'
  | 'humanCompleted'
  | 'windowExpired'
  | 'formRequired'
  | 'reserved'
  | 'holdConfirmed'
  | 'passengersAccepted'
  | 'availabilityLost'
  | 'approvalRequired'
  | 'authorizedReserve'
  | 'userApproved'
  | 'declined'
  | 'holdExpired'
  | 'ticketed'
  | 'providerRejected'
  | 'deadline'
  | 'cancel';

export interface TransitionDefinition {
  to: BookingState;
  trigger: TransitionTrigger;
  /** Guard identifiers — evaluated by the callers' guard functions, documented for auditability. */
  guards: readonly string[];
  /** Side effects executed in the same database transaction (documented; executed by services). */
  sideEffects: readonly string[];
}

const T = (
  to: BookingState,
  trigger: TransitionTrigger,
  guards: readonly string[] = [],
  sideEffects: readonly string[] = [],
): TransitionDefinition => ({ to, trigger, guards, sideEffects });

/**
 * Authoritative transition table (docs/booking-state-machine.md § 2).
 * Terminal states intentionally have no entries.
 */
export const TRANSITIONS: Readonly<Record<BookingState, readonly TransitionDefinition[]>> = {
  CREATED: [
    T('VALIDATING', 'submit', ['idempotency', 'tenantActive', 'userNotSuspended'], ['timeline:request_created', 'audit']),
    // `* → CANCELLED` (docs § 2): every non-terminal state may be cancelled by its owner. Without
    // this row a user could not cancel a request they created a second ago.
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
  ],
  VALIDATING: [
    T('SCHEDULED', 'validated', ['route', 'dates', 'passengers', 'entitlement', 'quota', 'automationAllowed'], [
      'monitors:create',
      'quota:increment',
      'timeline',
    ]),
    T('FAILED', 'validationFailed', [], ['quota:release', 'notify:booking_failure', 'audit']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'quota:release', 'audit']),
  ],
  SCHEDULED: [
    T('QUEUED', 'admitted', ['admission'], ['monitor:next_search_at', 'timeline']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
    T('EXPIRED', 'deadline', [], ['monitors:stop', 'notify:booking_expired']),
  ],
  QUEUED: [
    T('SEARCHING', 'tick', ['rateLimit', 'breakerClosed', 'maintenanceOff'], ['search_job:create', 'attempt:create', 'timeline:monitoring_activated']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
    T('EXPIRED', 'deadline', [], ['monitors:stop', 'notify:booking_expired']),
  ],
  SEARCHING: [
    T('WAITING', 'noMatch', [], ['observation:record', 'backoff', 'timeline']),
    T('AVAILABLE', 'match', ['scoreThreshold', 'price', 'availability', 'constraints'], [
      'results:persist',
      'notify:ticket_found',
      'timeline',
    ]),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
    T('EXPIRED', 'deadline', [], ['monitors:stop', 'notify:booking_expired']),
  ],
  WAITING: [
    T('SEARCHING', 'tick', ['rateLimit', 'breakerClosed', 'maintenanceOff'], ['search_job:create', 'attempt:create']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
    T('EXPIRED', 'deadline', [], ['monitors:stop', 'notify:booking_expired']),
  ],
  AVAILABLE: [
    T('LOCKED', 'lock', ['redisLock', 'rowLock', 'noLiveReservation', 'notAlreadyBooked', 'freshIdempotency'], [
      'fencing:store',
      'timeline:booking_locked',
      'audit',
    ]),
    T('WAITING', 'noMatch', ['retryBudget'], ['results:reject', 'timeline']),
    T('EXPIRED', 'deadline', [], ['monitors:stop', 'notify:booking_expired']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'audit']),
  ],
  LOCKED: [
    T('RESERVING', 'submitReservation', ['submissionGuards'], ['charge:authorize', 'attempt:reserving', 'timeline']),
    T('FAILED', 'providerRejected', ['lockLost'], ['timeline', 'audit']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  RESERVING: [
    T('HUMAN_VERIFICATION_REQUIRED', 'verificationDetected', [], ['pause', 'preserveContext', 'notify:verification_required', 'sla:start']),
    T('PASSENGER_FORM', 'formRequired', ['capability:passengerForm', 'passengersNonEmpty'], ['timeline:passenger_data_submitted']),
    T('RESERVED', 'holdConfirmed', ['providerReference'], ['reservation:persist', 'timeline']),
    T('FAILED', 'providerRejected', [], ['release:charge', 'notify:booking_failure', 'audit']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  HUMAN_VERIFICATION_REQUIRED: [
    T('RESERVING', 'humanCompleted', ['sessionValid', 'holdNotExpired'], ['timeline:verification_completed']),
    T('FAILED', 'windowExpired', [], ['release:charge', 'notify:booking_failure']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  PASSENGER_FORM: [
    T('READY_FOR_CHECKOUT', 'passengersAccepted', ['providerAcceptedPassengers', 'atomicReservation'], ['timeline']),
    T('AVAILABLE', 'availabilityLost', ['retryBudget'], ['backoff', 'release:charge', 'notify:booking_failure_soft']),
    T('FAILED', 'providerRejected', [], ['release:charge', 'audit']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  READY_FOR_CHECKOUT: [
    T('AWAITING_USER_APPROVAL', 'approvalRequired', ['modeRequiresApproval'], ['notify:approval_required', 'deadline:set']),
    T('RESERVED', 'authorizedReserve', ['modeAuthorized', 'consent', 'providerApproved', 'adminFlag', 'paymentAuthorization'], [
      'timeline:reservation_submitted',
    ]),
    T('FAILED', 'holdExpired', [], ['release:charge', 'notify:booking_failure']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  AWAITING_USER_APPROVAL: [
    T('RESERVED', 'userApproved', ['withinDeadline', 'consent', 'chargeValid'], ['timeline', 'audit']),
    T('FAILED', 'declined', [], ['release:charge', 'notify']),
    T('FAILED', 'holdExpired', [], ['release:charge', 'notify']),
    T('CANCELLED', 'cancel', ['permission'], ['monitors:stop', 'release:charge', 'audit']),
  ],
  RESERVED: [
    T('BOOKED', 'ticketed', ['providerConfirmation'], [
      'charge:settle',
      'notify:booking_success',
      'monitors:cancelLowerPriorities',
      'timeline:reservation_complete',
    ]),
    T('FAILED', 'providerRejected', [], ['charge:release', 'ledger:refund', 'notify:booking_failure', 'audit']),
    T('CANCELLED', 'cancel', ['permission', 'notTicketed'], ['provider:cancel', 'ledger:refund', 'audit']),
  ],
  BOOKED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function isTerminal(state: BookingState): boolean {
  return isTerminalBookingState(state);
}

export function transitionsFrom(state: BookingState): readonly TransitionDefinition[] {
  return TRANSITIONS[state] ?? [];
}

/**
 * Find the definition for a transition. A target may be reachable through more than one trigger
 * (e.g. `AWAITING_USER_APPROVAL → FAILED` happens both when the user declines and when the hold
 * expires), so the trigger can be supplied to disambiguate.
 */
export function findTransition(
  from: BookingState,
  to: BookingState,
  trigger?: TransitionTrigger,
): TransitionDefinition | null {
  return (
    transitionsFrom(from).find(
      (transition) => transition.to === to && (trigger === undefined || transition.trigger === trigger),
    ) ?? null
  );
}

export function canTransition(from: BookingState, to: BookingState, trigger?: TransitionTrigger): boolean {
  return findTransition(from, to, trigger) !== null;
}

export function isBookingState(value: unknown): value is BookingState {
  return typeof value === 'string' && (BOOKING_STATES as readonly string[]).includes(value);
}

/**
 * Validate a transition. Throws `CONFLICT` (409) with the legal alternatives, which is what the API
 * returns to a client that tried an illegal action (e.g. approving an expired request).
 */
export function assertTransition(from: unknown, to: unknown): TransitionDefinition {
  if (!isBookingState(from) || !isBookingState(to)) {
    throw new AppError('VALIDATION_FAILED', `unknown booking state: ${String(from)} → ${String(to)}`, {
      userMessageKey: 'error.validation_failed',
      details: { from, to },
    });
  }
  const definition = findTransition(from, to);
  if (!definition) {
    const allowed = transitionsFrom(from).map((transition) => transition.to);
    throw conflict(`illegal booking transition ${from} → ${to}`, {
      from,
      to,
      allowed,
      terminal: isTerminal(from),
    });
  }
  return definition;
}

/** Side effects that must be executed in the same transaction as the status write. */
export function sideEffectsFor(from: BookingState, to: BookingState): readonly string[] {
  // Merged across every definition that reaches `to`: when two triggers lead to the same state their
  // effects must both be honoured (the effect list itself is idempotent by design).
  const effects: string[] = [];
  for (const transition of transitionsFrom(from)) {
    if (transition.to !== to) continue;
    for (const effect of transition.sideEffects) {
      if (!effects.includes(effect)) effects.push(effect);
    }
  }
  return effects;
}

// ------------------------------------------------------------------ invariants --

export interface InvariantContext {
  hasLiveReservation?: boolean;
  hasProviderReference?: boolean;
  liveReservationCount?: number;
  pendingCharges?: number;
  settledCharges?: number;
  releasedCharges?: number;
  reachedStates?: readonly BookingState[];
}

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

/**
 * Invariants from docs/booking-state-machine.md § 2. Called after a transition inside the same
 * transaction; a violation aborts the transaction (there is no "log and continue" path).
 */
export function checkInvariants(state: BookingState, context: InvariantContext = {}): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (isTerminal(state) && transitionsFrom(state).length > 0) {
    violations.push({ invariant: 'terminal-has-no-exit', detail: `${state} must not have outgoing transitions` });
  }

  if (['LOCKED', 'RESERVING', 'RESERVED', 'BOOKED'].includes(state)) {
    const reached = context.reachedStates ?? [];
    if (reached.length > 0 && !reached.includes('AVAILABLE')) {
      violations.push({
        invariant: 'lock-requires-availability',
        detail: `reached ${state} without passing through AVAILABLE`,
      });
    }
  }

  if (state === 'BOOKED' && context.hasProviderReference === false) {
    violations.push({ invariant: 'booked-requires-reference', detail: 'BOOKED without a provider reference' });
  }

  if ((context.liveReservationCount ?? 0) > 1) {
    violations.push({
      invariant: 'single-live-reservation',
      detail: `${context.liveReservationCount} live reservations for one request`,
    });
  }

  if ((context.pendingCharges ?? 0) > 0 && isTerminal(state) && state !== 'CANCELLED') {
    // A failed/expired request must never leave a pending charge behind.
    if ((context.settledCharges ?? 0) === 0 && (context.releasedCharges ?? 0) === 0) {
      violations.push({
        invariant: 'charges-are-paired',
        detail: `terminal state ${state} left ${context.pendingCharges} pending charge(s)`,
      });
    }
  }

  return violations;
}

export function assertInvariants(state: BookingState, context: InvariantContext = {}): void {
  const violations = checkInvariants(state, context);
  if (violations.length > 0) {
    throw new AppError('INTERNAL_ERROR', `booking invariant violated: ${violations.map((v) => v.invariant).join(', ')}`, {
      userMessageKey: 'error.internal',
      details: { state, violations },
    });
  }
}

/** All states reachable from `start` (used by tests and by the admin UI to explain the flow). */
export function reachableStates(start: BookingState): BookingState[] {
  const seen = new Set<BookingState>();
  const queue: BookingState[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as BookingState;
    for (const transition of transitionsFrom(current)) {
      if (!seen.has(transition.to)) {
        seen.add(transition.to);
        queue.push(transition.to);
      }
    }
  }
  return [...seen].sort();
}
