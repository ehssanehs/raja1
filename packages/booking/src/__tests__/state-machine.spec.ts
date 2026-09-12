/**
 * State machine invariants (docs/booking-state-machine.md § 2).
 *
 * These tests are the executable form of the document: if a transition is added there without
 * being added here, the completeness tests fail.
 */
import { describe, expect, it } from 'vitest';
import { BOOKING_STATES, type BookingState } from '@raja/shared';
import {
  TRANSITIONS,
  assertInvariants,
  assertTransition,
  canTransition,
  checkInvariants,
  findTransition,
  isTerminal,
  reachableStates,
  sideEffectsFor,
  transitionsFrom,
} from '../state-machine';

const TERMINAL: BookingState[] = ['BOOKED', 'FAILED', 'EXPIRED', 'CANCELLED'];

describe('transition table', () => {
  it('covers every known state', () => {
    for (const state of BOOKING_STATES) {
      expect(TRANSITIONS[state], `missing transitions for ${state}`).toBeDefined();
    }
  });

  it('has no outgoing transitions from terminal states', () => {
    for (const state of TERMINAL) {
      expect(isTerminal(state)).toBe(true);
      expect(transitionsFrom(state)).toHaveLength(0);
    }
  });

  it('marks exactly four states as terminal', () => {
    expect(BOOKING_STATES.filter((state) => isTerminal(state)).sort()).toEqual([...TERMINAL].sort());
  });

  it('never transitions to itself', () => {
    for (const state of BOOKING_STATES) {
      for (const transition of transitionsFrom(state)) {
        expect(transition.to, `${state} → itself`).not.toBe(state);
      }
    }
  });

  it('documents guards and side effects for every non-trivial transition', () => {
    for (const state of BOOKING_STATES) {
      for (const transition of transitionsFrom(state)) {
        expect(Array.isArray(transition.guards)).toBe(true);
        expect(Array.isArray(transition.sideEffects)).toBe(true);
        if (['LOCKED', 'RESERVING', 'RESERVED', 'BOOKED'].includes(transition.to)) {
          expect(transition.sideEffects.length, `${state} → ${transition.to} has no side effects`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('exposes the documented happy path', () => {
    const path: BookingState[] = [
      'CREATED',
      'VALIDATING',
      'SCHEDULED',
      'QUEUED',
      'SEARCHING',
      'AVAILABLE',
      'LOCKED',
      'RESERVING',
      'RESERVED',
      'BOOKED',
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index] as BookingState, path[index + 1] as BookingState), `${path[index]}→${path[index + 1]}`).toBe(
        true,
      );
    }
  });

  it('keeps the CAPTCHA path available and conservative', () => {
    expect(canTransition('RESERVING', 'HUMAN_VERIFICATION_REQUIRED')).toBe(true);
    expect(canTransition('HUMAN_VERIFICATION_REQUIRED', 'RESERVING')).toBe(true);
    expect(canTransition('HUMAN_VERIFICATION_REQUIRED', 'FAILED')).toBe(true);
    // There is no transition that bypasses human verification into a booked state.
    expect(canTransition('HUMAN_VERIFICATION_REQUIRED', 'BOOKED')).toBe(false);
    expect(canTransition('HUMAN_VERIFICATION_REQUIRED', 'RESERVED')).toBe(false);
  });

  it('requires approval before an auto-mode reservation when the mode is not authorised', () => {
    expect(canTransition('READY_FOR_CHECKOUT', 'AWAITING_USER_APPROVAL')).toBe(true);
    expect(canTransition('READY_FOR_CHECKOUT', 'RESERVED')).toBe(true);
    const authorized = findTransition('READY_FOR_CHECKOUT', 'RESERVED');
    expect(authorized?.guards).toContain('modeAuthorized');
    expect(authorized?.guards).toContain('consent');
    expect(authorized?.guards).toContain('providerApproved');
    expect(authorized?.guards).toContain('adminFlag');
    expect(authorized?.guards).toContain('paymentAuthorization');
  });
});

describe('assertTransition', () => {
  it('returns the definition for a legal transition', () => {
    expect(assertTransition('SEARCHING', 'AVAILABLE').sideEffects).toContain('results:persist');
  });

  it('rejects illegal transitions with the legal alternatives', () => {
    try {
      assertTransition('CREATED', 'BOOKED');
      throw new Error('should have thrown');
    } catch (error) {
      const appError = error as { code?: string; details?: { allowed?: string[] } };
      expect(appError.code).toBe('CONFLICT');
      expect(appError.details?.allowed).toContain('VALIDATING');
    }
  });

  it('rejects unknown state names', () => {
    expect(() => assertTransition('CREATED', 'WAT')).toThrowError(/unknown booking state/i);
  });

  it('rejects a transition out of a terminal state', () => {
    for (const state of TERMINAL) {
      expect(() => assertTransition(state, 'SEARCHING')).toThrowError(/illegal booking transition/i);
    }
  });

  it('reports the side effects that a service must run in the same transaction', () => {
    expect(sideEffectsFor('RESERVED', 'BOOKED')).toContain('charge:settle');
    expect(sideEffectsFor('RESERVED', 'BOOKED')).toContain('monitors:cancelLowerPriorities');
    expect(sideEffectsFor('AVAILABLE', 'LOCKED')).toContain('fencing:store');
  });
});

describe('invariants', () => {
  it('accepts a consistent context', () => {
    expect(checkInvariants('BOOKED', { hasProviderReference: true, liveReservationCount: 1 })).toEqual([]);
    expect(() => assertInvariants('BOOKED', { hasProviderReference: true })).not.toThrow();
  });

  it('rejects BOOKED without a provider reference', () => {
    const violations = checkInvariants('BOOKED', { hasProviderReference: false });
    expect(violations.map((violation) => violation.invariant)).toContain('booked-requires-reference');
  });

  it('rejects entering a locked state without passing through AVAILABLE', () => {
    for (const state of ['LOCKED', 'RESERVING', 'RESERVED'] as BookingState[]) {
      const violations = checkInvariants(state, { reachedStates: ['CREATED', 'SCHEDULED'] });
      expect(violations.map((violation) => violation.invariant)).toContain('lock-requires-availability');
    }
  });

  it('rejects more than one live reservation for a request', () => {
    const violations = checkInvariants('RESERVED', { liveReservationCount: 2 });
    expect(violations.map((violation) => violation.invariant)).toContain('single-live-reservation');
  });

  it('rejects a terminal failure that leaves a charge pending', () => {
    const violations = checkInvariants('FAILED', { pendingCharges: 1, settledCharges: 0, releasedCharges: 0 });
    expect(violations.map((violation) => violation.invariant)).toContain('charges-are-paired');
  });
});

describe('reachability', () => {
  it('can reach BOOKED from CREATED', () => {
    expect(reachableStates('CREATED')).toContain('BOOKED');
  });

  it('cannot reach BOOKED directly from a terminal state', () => {
    expect(reachableStates('CANCELLED')).toEqual([]);
  });

  it('reaches every other non-terminal state from CREATED (no dead code in the table)', () => {
    const reachable = new Set(reachableStates('CREATED'));
    const unreachable = BOOKING_STATES.filter(
      (state) => state !== 'CREATED' && !TERMINAL.includes(state) && !reachable.has(state),
    );
    expect(unreachable).toEqual([]);
  });
});
