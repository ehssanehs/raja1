/**
 * Matching and scoring (spec § 12, § 17).
 */
import { describe, expect, it } from 'vitest';
import type { ProviderTrip } from '@raja/provider-sdk';
import {
  DEFAULT_ACCEPTANCE_THRESHOLD,
  evaluateMatch,
  pairItineraries,
  rankTrips,
  seatSatisfies,
  type MatchRequest,
} from '../matching';

const TEHRAN_OFFSET_MINUTES = 210; // UTC+03:30

function trip(overrides: Partial<ProviderTrip> = {}): ProviderTrip {
  return {
    providerTripId: 'T1',
    trainNumber: '101',
    trainName: 'Test Express',
    coachClass: 'SECOND',
    // 06:15 UTC = 09:45 Tehran
    departureAt: '2026-03-01T06:15:00.000Z',
    arrivalAt: '2026-03-01T12:15:00.000Z',
    durationMinutes: 360,
    originCode: 'THR',
    destinationCode: 'MHD',
    price: { amountMinor: 2_000_000, currency: 'IRR' },
    seatsAvailable: 12,
    seatLabels: ['11', '12', '13'],
    fingerprint: 'fp',
    leg: 'OUTBOUND',
    ...overrides,
  };
}

function request(overrides: Partial<MatchRequest> = {}): MatchRequest {
  return {
    matchingMode: 'FLEXIBLE',
    passengers: 2,
    minAvailability: 2,
    coachClass: 'ANY',
    seatPreference: 'ANY',
    maxPriceMinor: 3_000_000,
    currency: 'IRR',
    ...overrides,
  };
}

const context = { timezoneOffsetMinutes: TEHRAN_OFFSET_MINUTES };

describe('hard constraints', () => {
  it('rejects a trip with fewer seats than passengers', () => {
    const decision = evaluateMatch(request({ passengers: 4 }), trip({ seatsAvailable: 3 }), context);
    expect(decision.matched).toBe(false);
    expect(decision.rejections).toContain('insufficient_seats_for_passengers');
  });

  it('rejects a trip above the price ceiling', () => {
    const decision = evaluateMatch(
      request({ maxPriceMinor: 1_000_000 }),
      trip({ price: { amountMinor: 1_500_000, currency: 'IRR' } }),
      context,
    );
    expect(decision.matched).toBe(false);
    expect(decision.rejections).toContain('over_max_price');
  });

  it('rejects an unknown price when the user set a ceiling', () => {
    const decision = evaluateMatch(request(), trip({ price: null }), context);
    expect(decision.matched).toBe(false);
    expect(decision.rejections).toContain('price_unknown_with_ceiling');
  });

  it('enforces the requested class in both modes', () => {
    for (const matchingMode of ['STRICT', 'FLEXIBLE'] as const) {
      const decision = evaluateMatch(request({ matchingMode, coachClass: 'FIRST' }), trip(), context);
      expect(decision.matched).toBe(false);
      expect(decision.rejections).toContain('class_mismatch');
    }
  });
});

describe('matching modes', () => {
  const outsideWindow = { preferredDepartureFrom: '18:00', preferredDepartureTo: '22:00' };

  it('STRICT rejects a trip outside the preferred departure window', () => {
    const decision = evaluateMatch(request({ matchingMode: 'STRICT', ...outsideWindow }), trip(), context);
    expect(decision.matched).toBe(false);
    expect(decision.rejections).toContain('outside_preferred_departure_window');
  });

  it('FLEXIBLE keeps the trip but deducts score', () => {
    const strict = evaluateMatch(request({ matchingMode: 'STRICT', ...outsideWindow }), trip(), context);
    const flexible = evaluateMatch(request({ matchingMode: 'FLEXIBLE', ...outsideWindow }), trip(), context);
    expect(flexible.matched).toBe(true);
    expect(flexible.deductions).toContain('outside_preferred_departure_window');
    expect(flexible.score).toBeLessThan(strict.score + 100); // sanity: score is bounded
    expect(flexible.score).toBeGreaterThanOrEqual(DEFAULT_ACCEPTANCE_THRESHOLD);
  });

  it('STRICT requires the preferred train; FLEXIBLE only deducts', () => {
    const preferred = ['999'];
    const strict = evaluateMatch(request({ matchingMode: 'STRICT', preferredTripIds: preferred }), trip(), context);
    expect(strict.rejections).toContain('train_not_preferred');
    const flexible = evaluateMatch(request({ matchingMode: 'FLEXIBLE', preferredTripIds: preferred }), trip(), context);
    expect(flexible.matched).toBe(true);
    expect(flexible.deductions).toContain('train_not_preferred');
    expect(flexible.breakdown.trainPreference).toBe(0);
  });

  it('respects the acceptance threshold', () => {
    const low = evaluateMatch(request({ acceptanceThreshold: 1 }), trip(), context);
    const high = evaluateMatch(request({ acceptanceThreshold: 100 }), trip(), context);
    expect(low.matched).toBe(true);
    expect(high.matched).toBe(false);
  });
});

describe('scoring', () => {
  it('scores a better-priced trip higher', () => {
    const cheap = evaluateMatch(request(), trip({ price: { amountMinor: 900_000, currency: 'IRR' } }), context);
    const pricey = evaluateMatch(request(), trip({ price: { amountMinor: 2_900_000, currency: 'IRR' } }), context);
    expect(cheap.breakdown.price).toBeGreaterThan(pricey.breakdown.price);
    expect(cheap.score).toBeGreaterThan(pricey.score);
  });

  it('scores more availability higher, with diminishing returns', () => {
    const few = evaluateMatch(request(), trip({ seatsAvailable: 2 }), context);
    const many = evaluateMatch(request(), trip({ seatsAvailable: 40 }), context);
    expect(many.breakdown.availability).toBeGreaterThan(few.breakdown.availability);
    expect(many.breakdown.availability).toBeLessThanOrEqual(20);
  });

  it('keeps the total within 0..100', () => {
    const best = evaluateMatch(
      request({ preferredDepartureFrom: '09:30', preferredDepartureTo: '10:30', preferredTripIds: ['T1'], seatPreference: 'LOWER_BERTH' }),
      trip(),
      context,
    );
    expect(best.score).toBeLessThanOrEqual(100);
    expect(best.score).toBeGreaterThan(0);
    expect(Object.values(best.breakdown).reduce((a, b) => a + b, 0)).toBe(best.score);
  });

  it('ranks deterministically: score, then price, then departure', () => {
    const ranked = rankTrips(
      request(),
      [
        trip({ providerTripId: 'B', price: { amountMinor: 2_500_000, currency: 'IRR' } }),
        trip({ providerTripId: 'A', price: { amountMinor: 2_500_000, currency: 'IRR' } }),
        trip({ providerTripId: 'C', price: { amountMinor: 1_200_000, currency: 'IRR' } }),
      ],
      context,
    );
    expect(ranked.map((entry) => entry.trip.providerTripId)).toEqual(['C', 'A', 'B']);
  });

  it('filters out every rejected trip in rankTrips', () => {
    const ranked = rankTrips(request({ passengers: 5 }), [trip({ seatsAvailable: 2 }), trip({ seatsAvailable: 9 })], context);
    expect(ranked).toHaveLength(1);
  });
});

describe('seat preferences', () => {
  it('only claims what labels can prove', () => {
    expect(seatSatisfies('ANY', [])).toBe(true);
    expect(seatSatisfies('LOWER_BERTH', ['11', '12'])).toBe(true); // 11 is odd → lower
    expect(seatSatisfies('UPPER_BERTH', ['11'])).toBe(false);
    expect(seatSatisfies('UPPER_BERTH', ['12'])).toBe(true);
    // Position cannot be derived from a label, so it is never claimed.
    expect(seatSatisfies('WINDOW', ['11'])).toBe(false);
    expect(seatSatisfies('AISLE', ['12'])).toBe(false);
    expect(seatSatisfies('SAME_COMPARTMENT', ['11', '12'])).toBe(true);
    expect(seatSatisfies('SAME_COMPARTMENT', ['11'])).toBe(false);
  });
});

describe('itinerary pairing', () => {
  const outbound = trip({ providerTripId: 'OUT', leg: 'OUTBOUND' });
  const inboundLater = trip({
    providerTripId: 'RET',
    leg: 'RETURN',
    departureAt: '2026-03-05T06:15:00.000Z',
  });

  it('pairs return legs that depart after the outbound', () => {
    const ranked = rankTrips(request(), [outbound, inboundLater], context);
    const pairs = pairItineraries(ranked, { requiresReturn: true });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.outbound.providerTripId).toBe('OUT');
    expect(pairs[0]?.inbound?.providerTripId).toBe('RET');
  });

  it('does not pair a return leg that departs before the outbound', () => {
    const earlier = trip({ providerTripId: 'RET', leg: 'RETURN', departureAt: '2026-02-27T06:15:00.000Z' });
    const ranked = rankTrips(request(), [outbound, earlier], context);
    expect(pairItineraries(ranked, { requiresReturn: true })).toHaveLength(0);
  });

  it('returns an empty pairing when no return leg matched', () => {
    const ranked = rankTrips(request(), [outbound], context);
    expect(pairItineraries(ranked, { requiresReturn: true })).toHaveLength(0);
  });

  it('offers only outbound options when the request needs one direction', () => {
    const ranked = rankTrips(request(), [outbound, inboundLater], context);
    const pairs = pairItineraries(ranked, { requiresReturn: false });
    // Return legs are not offered as standalone options: a single-direction request must never
    // accidentally book the wrong leg.
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.outbound.providerTripId).toBe('OUT');
    expect(pairs.every((pair) => pair.inbound === null)).toBe(true);
  });
});
