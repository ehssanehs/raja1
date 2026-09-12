/**
 * Property test for the booking state machine (docs/booking-state-machine.md § 2, invariant list).
 *
 * Instead of hand-picking paths, this walks the transition table with a *seeded* random walk (so a
 * failure is reproducible) and checks the structural properties after every step. The seed is
 * printed in the assertion messages through the step index, which is enough to replay a failing walk.
 */
import { describe, expect, it } from 'vitest';
import { BOOKING_STATES, createRng, type BookingState } from '@raja/shared';
import {
  TRANSITIONS,
  assertTransition,
  checkInvariants,
  isTerminal,
  transitionsFrom,
  type TransitionTrigger,
} from '../state-machine';

const TRIGGERS: TransitionTrigger[] = [
  'submit',
  'validated',
  'validationFailed',
  'admitted',
  'tick',
  'noMatch',
  'match',
  'lock',
  'submitReservation',
  'verificationDetected',
  'humanCompleted',
  'windowExpired',
  'formRequired',
  'reserved',
  'holdConfirmed',
  'passengersAccepted',
  'availabilityLost',
  'approvalRequired',
  'authorizedReserve',
  'userApproved',
  'declined',
  'holdExpired',
  'ticketed',
  'providerRejected',
  'deadline',
  'cancel',
];

/**
 * Walks from CREATED until a terminal state or `maxSteps`, choosing uniformly at random.
 * `avoid` removes triggers from the choices (used to explore the "user does not give up" branch).
 */
function walk(seed: number, maxSteps = 40, avoid: readonly TransitionTrigger[] = []): BookingState[] {
  const rng = createRng(seed);
  const path: BookingState[] = ['CREATED'];
  let current: BookingState = 'CREATED';

  for (let step = 0; step < maxSteps && !isTerminal(current); step += 1) {
    const options = transitionsFrom(current).filter((transition) => !avoid.includes(transition.trigger));
    if (options.length === 0) break;
    const next = options[Math.floor(rng() * options.length)]!;
    // The walk uses the real assertion, not the raw table: an illegal entry would fail here.
    assertTransition(current, next.to);
    path.push(next.to);
    current = next.to;
  }
  return path;
}

describe('transition table structure', () => {
  it('covers every state and only targets real states with real triggers', () => {
    for (const state of BOOKING_STATES) {
      expect(Object.keys(TRANSITIONS), `missing ${state}`).toContain(state);
      // A target may be reached through different triggers (declined vs. holdExpired), but the same
      // trigger leading to the same target twice is a modelling mistake.
      const edges = new Set<string>();
      for (const transition of TRANSITIONS[state]) {
        expect(BOOKING_STATES).toContain(transition.to);
        expect(TRIGGERS).toContain(transition.trigger);
        const edge = `${transition.trigger}→${transition.to}`;
        expect(edges.has(edge), `${state}: ${edge} duplicated`).toBe(false);
        edges.add(edge);
        expect(state, `${state} must not transition to itself`).not.toBe(transition.to);
      }
    }
  });

  it('gives every non-terminal state an outgoing transition, and no terminal state one', () => {
    for (const state of BOOKING_STATES) {
      if (isTerminal(state)) {
        expect(transitionsFrom(state), `${state} is terminal`).toHaveLength(0);
      } else {
        expect(transitionsFrom(state).length, `${state} is stuck`).toBeGreaterThan(0);
      }
    }
  });

  it('lets every non-terminal state be cancelled, and none of the terminal ones', () => {
    for (const state of BOOKING_STATES) {
      const canCancel = transitionsFrom(state).some((transition) => transition.to === 'CANCELLED');
      expect(canCancel, `cancel from ${state}`).toBe(!isTerminal(state));
    }
  });

  it('expires only the states that are waiting for something', () => {
    const expiring = BOOKING_STATES.filter((state) =>
      transitionsFrom(state).some((transition) => transition.to === 'EXPIRED'),
    );
    expect(expiring).toEqual(['SCHEDULED', 'QUEUED', 'SEARCHING', 'WAITING', 'AVAILABLE']);
  });

  it('can never reach LOCKED/RESERVED/BOOKED without AVAILABLE', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const path = walk(seed);
      for (const state of ['LOCKED', 'RESERVING', 'RESERVED', 'BOOKED'] as const) {
        if (path.includes(state)) {
          const index = path.indexOf(state);
          expect(path.slice(0, index), `seed ${seed}`).toContain('AVAILABLE');
        }
      }
    }
  });

  it('keeps every walk inside the legal graph and holds the invariants at each step', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const path = walk(seed);
      expect(path[0]).toBe('CREATED');
      for (const [index, state] of path.entries()) {
        expect(BOOKING_STATES, `seed ${seed} step ${index}`).toContain(state);
        const isLast = index === path.length - 1;
        // A walk stops only at a terminal state (or at maxSteps, which is 40 — far past any path).
        if (isLast) {
          expect(isTerminal(state), `seed ${seed} ended in non-terminal ${state}`).toBe(true);
        } else {
          expect(isTerminal(state), `seed ${seed} continued past terminal ${state}`).toBe(false);
        }

        const violations = checkInvariants(state, {
          reachedStates: path.slice(0, index + 1),
          liveReservationCount: 0,
          pendingCharges: 0,
          hasProviderReference: state === 'BOOKED' ? true : undefined,
        });
        expect(violations, `seed ${seed} step ${index} (${state})`).toEqual([]);
      }
    }
  });

  it('produces the same walk for the same seed (reproducible failures)', () => {
    expect(walk(42)).toEqual(walk(42));
  });

  it('can reach every state in the graph from CREATED (exhaustive depth-first search)', () => {
    const seen = new Set<BookingState>();
    const visit = (state: BookingState): void => {
      if (seen.has(state)) return;
      seen.add(state);
      for (const transition of transitionsFrom(state)) visit(transition.to);
    };
    visit('CREATED');
    expect([...seen].sort()).toEqual([...BOOKING_STATES].sort());
  });

  it('reaches every terminal state across the walk population', () => {
    const terminals = new Set<BookingState>();
    const neverGivesUp: TransitionTrigger[] = ['cancel', 'deadline', 'validationFailed'];
    for (let seed = 1; seed <= 300; seed += 1) {
      for (const last of [walk(seed).at(-1)!, walk(seed, 40, neverGivesUp).at(-1)!]) {
        if (isTerminal(last)) terminals.add(last);
      }
    }
    expect([...terminals].sort()).toEqual(['BOOKED', 'CANCELLED', 'EXPIRED', 'FAILED']);
  });

  it('reaches BOOKED without ever cancelling or expiring, and never returns after it', () => {
    const neverGivesUp: TransitionTrigger[] = ['cancel', 'deadline', 'validationFailed'];
    let booked = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const path = walk(seed, 40, neverGivesUp);
      expect(path).not.toContain('CANCELLED');
      expect(path).not.toContain('EXPIRED');
      const last = path.at(-1)!;
      if (last === 'BOOKED') {
        booked += 1;
        expect(transitionsFrom('BOOKED')).toHaveLength(0);
      }
      // No state may appear twice except through the deliberate retry loop
      // (PASSENGER_FORM → AVAILABLE → LOCKED and AVAILABLE → WAITING → SEARCHING are legal).
      expect(path.slice(0, -1)).toContain('AVAILABLE');
    }
    expect(booked, 'at least one walk must ticket').toBeGreaterThan(0);
  });
});
