/**
 * Matching and scoring (spec § 12, § 17).
 *
 * Two modes, and the difference is deliberate:
 *
 *  - `STRICT`   — every user constraint is a hard filter. A trip that fails any of them is not a
 *                 candidate at all, even if it is cheap.
 *  - `FLEXIBLE` — hard constraints stay hard (price ceiling, availability, class, passenger count);
 *                 *preferences* (departure window, train, seat) only reduce the score, so the user
 *                 still gets an offer when the exact train is not available.
 *
 * Scoring is deterministic and its breakdown is persisted with every result (`score_breakdown`), so
 * "why was this offer chosen?" is answerable months later.
 */
import type { CoachClass, SeatPreference } from '@raja/shared';
import type { ProviderTrip } from '@raja/provider-sdk';

export type MatchingMode = 'STRICT' | 'FLEXIBLE';

export interface MatchRequest {
  matchingMode: MatchingMode;
  passengers: number;
  minAvailability: number;
  coachClass: CoachClass;
  seatPreference: SeatPreference;
  maxPriceMinor?: number | null;
  currency: string;
  preferredDepartureFrom?: string | null;
  preferredDepartureTo?: string | null;
  preferredTripIds?: readonly string[];
  /** Score below which an offer is not surfaced (spec § 12: default 50). */
  acceptanceThreshold?: number;
}

export interface ScoreBreakdown {
  price: number;
  availability: number;
  departureWindow: number;
  trainPreference: number;
  seatPreference: number;
}

export interface MatchDecision {
  matched: boolean;
  score: number;
  breakdown: ScoreBreakdown;
  /** Hard-filter failures: present ⇒ matched is false. */
  rejections: string[];
  /** Preference misses that only cost score. */
  deductions: string[];
}

export const DEFAULT_ACCEPTANCE_THRESHOLD = 50;

const WEIGHTS = {
  price: 35,
  availability: 20,
  departureWindow: 25,
  trainPreference: 10,
  seatPreference: 10,
} as const;

/** Seconds since midnight in *provider-local* time for a trip departure. */
function localMinutes(departureAtIso: string, timezoneOffsetMinutes: number): number {
  const instant = new Date(departureAtIso);
  const local = new Date(instant.getTime() + timezoneOffsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface MatchContext {
  /** Provider timezone offset in minutes at the trip's instant (+210 for Tehran). */
  timezoneOffsetMinutes: number;
}

export function evaluateMatch(request: MatchRequest, trip: ProviderTrip, context: MatchContext): MatchDecision {
  const rejections: string[] = [];
  const deductions: string[] = [];
  const breakdown: ScoreBreakdown = {
    price: 0,
    availability: 0,
    departureWindow: 0,
    trainPreference: 0,
    seatPreference: 0,
  };

  // ---- hard filters (both modes) -------------------------------------------
  if (trip.seatsAvailable < request.passengers) rejections.push('insufficient_seats_for_passengers');
  if (trip.seatsAvailable < request.minAvailability) rejections.push('below_min_availability');
  if (request.coachClass !== 'ANY' && trip.coachClass !== request.coachClass) rejections.push('class_mismatch');
  if (
    request.maxPriceMinor !== null &&
    request.maxPriceMinor !== undefined &&
    trip.price !== null &&
    trip.price.amountMinor > request.maxPriceMinor
  ) {
    rejections.push('over_max_price');
  }
  if (trip.price === null && request.maxPriceMinor !== null && request.maxPriceMinor !== undefined) {
    // Unknown price with a price ceiling: we cannot promise the budget, so it is not a candidate.
    rejections.push('price_unknown_with_ceiling');
  }

  // ---- scored components ----------------------------------------------------
  if (trip.price !== null && request.maxPriceMinor) {
    const ratio = 1 - Math.min(1, trip.price.amountMinor / request.maxPriceMinor);
    breakdown.price = Math.round(WEIGHTS.price * (0.5 + 0.5 * ratio));
  } else if (trip.price !== null) {
    breakdown.price = Math.round(WEIGHTS.price * 0.7);
  }

  const seatTarget = Math.max(request.passengers, 1) * 3;
  breakdown.availability = Math.round(WEIGHTS.availability * Math.min(1, trip.seatsAvailable / seatTarget));

  const from = parseHhMm(request.preferredDepartureFrom);
  const to = parseHhMm(request.preferredDepartureTo);
  const departure = localMinutes(trip.departureAt, context.timezoneOffsetMinutes);
  if (from !== null && to !== null) {
    const inside = from <= to ? departure >= from && departure <= to : departure >= from || departure <= to;
    if (inside) {
      breakdown.departureWindow = WEIGHTS.departureWindow;
    } else {
      const distance = Math.min(Math.abs(departure - from), Math.abs(departure - to));
      const penalty = Math.min(1, distance / (6 * 60));
      breakdown.departureWindow = Math.round(WEIGHTS.departureWindow * (1 - penalty));
      deductions.push('outside_preferred_departure_window');
      if (request.matchingMode === 'STRICT') rejections.push('outside_preferred_departure_window');
    }
  } else {
    breakdown.departureWindow = Math.round(WEIGHTS.departureWindow * 0.6);
  }

  if (request.preferredTripIds && request.preferredTripIds.length > 0) {
    if (request.preferredTripIds.includes(trip.providerTripId) || request.preferredTripIds.includes(trip.trainNumber)) {
      breakdown.trainPreference = WEIGHTS.trainPreference;
    } else {
      deductions.push('train_not_preferred');
      if (request.matchingMode === 'STRICT') rejections.push('train_not_preferred');
    }
  } else {
    breakdown.trainPreference = Math.round(WEIGHTS.trainPreference * 0.5);
  }

  if (request.seatPreference !== 'ANY' && trip.seatLabels.length > 0) {
    if (seatSatisfies(request.seatPreference, trip.seatLabels)) {
      breakdown.seatPreference = WEIGHTS.seatPreference;
    } else {
      deductions.push('seat_preference_unavailable');
      if (request.matchingMode === 'STRICT') rejections.push('seat_preference_unavailable');
    }
  } else {
    breakdown.seatPreference = Math.round(WEIGHTS.seatPreference * 0.5);
  }

  const score = Object.values(breakdown).reduce((total, value) => total + value, 0);
  const threshold = request.acceptanceThreshold ?? DEFAULT_ACCEPTANCE_THRESHOLD;
  const matched = rejections.length === 0 && score >= threshold;

  return { matched, score, breakdown, rejections, deductions };
}

/**
 * Seat preferences are expressed as labels plus a position. Providers return labels only, so the
 * match is conservative: we only claim a preference is satisfied when the label clearly supports
 * it. Everything else is a deduction, never a silent assumption.
 */
export function seatSatisfies(preference: SeatPreference, seatLabels: readonly string[]): boolean {
  const numeric = seatLabels
    .map((label) => Number(label.replace(/[^0-9]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);

  switch (preference) {
    case 'ANY':
      return true;
    // Iranian rail berths are numbered so that odd numbers are the lower berth and even numbers the
    // upper berth. That convention is the only one we can verify from a label alone.
    case 'LOWER_BERTH':
      return numeric.some((value) => value % 2 === 1);
    case 'UPPER_BERTH':
      return numeric.some((value) => value % 2 === 0);
    case 'SAME_COMPARTMENT':
      // Two consecutive seat numbers are almost always in the same compartment; we treat that as
      // satisfied only for two or more adjacent labels.
      return numeric.length >= 2 && numeric.some((value, index) => numeric[index + 1] === value + 1);
    case 'WINDOW':
    case 'AISLE':
    case 'MIDDLE':
      // Seat position is not derivable from a coach-seat label. Claiming it would be a guess, so the
      // preference becomes a score deduction (spec § 12) instead of a silent mismatch.
      return false;
    default:
      return true;
  }
}

export function rankTrips(
  request: MatchRequest,
  trips: readonly ProviderTrip[],
  context: MatchContext,
): Array<{ trip: ProviderTrip; decision: MatchDecision }> {
  return trips
    .map((trip) => ({ trip, decision: evaluateMatch(request, trip, context) }))
    .filter((entry) => entry.decision.matched)
    .sort((a, b) => {
      if (b.decision.score !== a.decision.score) return b.decision.score - a.decision.score;
      const priceA = a.trip.price?.amountMinor ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.trip.price?.amountMinor ?? Number.MAX_SAFE_INTEGER;
      if (priceA !== priceB) return priceA - priceB;
      const byDeparture = a.trip.departureAt.localeCompare(b.trip.departureAt);
      if (byDeparture !== 0) return byDeparture;
      // Final tie-break keeps ranking deterministic across identical offers.
      return a.trip.providerTripId.localeCompare(b.trip.providerTripId);
    });
}

/** Pair outbound/return legs so a request that needs both only books a coherent itinerary. */
export function pairItineraries(
  ranked: ReadonlyArray<{ trip: ProviderTrip; decision: MatchDecision }>,
  options: { requiresReturn: boolean },
): Array<{ outbound: ProviderTrip; inbound: ProviderTrip | null; score: number }> {
  const outbound = ranked.filter((entry) => entry.trip.leg === 'OUTBOUND');
  const inbound = ranked.filter((entry) => entry.trip.leg === 'RETURN');
  const pairs: Array<{ outbound: ProviderTrip; inbound: ProviderTrip | null; score: number }> = [];

  for (const out of outbound) {
    if (!options.requiresReturn) {
      pairs.push({ outbound: out.trip, inbound: null, score: out.decision.score });
      continue;
    }
    const best = inbound
      .filter((entry) => new Date(entry.trip.departureAt) > new Date(out.trip.departureAt))
      .sort((a, b) => b.decision.score - a.decision.score)[0];
    if (best) {
      pairs.push({ outbound: out.trip, inbound: best.trip, score: Math.round((out.decision.score + best.decision.score) / 2) });
    }
  }

  return pairs.sort((a, b) => b.score - a.score);
}
