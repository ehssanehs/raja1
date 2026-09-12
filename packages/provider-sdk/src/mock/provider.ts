/**
 * Deterministic mock provider (spec § 20, docs/github-plan.md M5).
 *
 * The mock is a first-class adapter, not a test double bolted on: CI, local development and the
 * provider contract tests all run against it, so no automated test ever touches a real provider.
 * It is deterministic for a given (route, date, seed) so failures reproduce exactly.
 */
import { createRng, money, uuid, type Money } from '@raja/shared';
import type { ProviderCapabilities } from '../capabilities';
import type {
  PassengerInput,
  ProviderAdapter,
  ProviderCallContext,
  ProviderHealth,
  ProviderReservationDraft,
  ProviderReservationStatus,
  ProviderSearchRequest,
  ProviderSearchResult,
  ProviderTrip,
  ReservationDraftInput,
} from '../types';
import { ProviderCallError } from '../types';
import { minutesBetween, tripFingerprint } from '../normalize';

export interface MockProviderOptions {
  /** Seed for deterministic generation. */
  seed?: number;
  /** Simulated trips per route/date. */
  tripsPerRoute?: number;
  /** Artificial latency; 0 in unit tests, a few ms in integration tests. */
  latencyMs?: number;
  /** Fraction of searches that report "no availability" (0..1). */
  soldOutRate?: number;
  /** Every Nth call fails with the given class; null disables fault injection. */
  failEvery?: number | null;
  failWith?: 'TIMEOUT' | 'NETWORK' | 'SCHEMA' | 'RATE_LIMIT' | 'CAPTCHA' | 'SOLD_OUT';
  currency?: Money['currency'];
}

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  supportsSeatSelection: true,
  supportsHold: true,
  supportsAutoBooking: true,
  supportsReturnTrips: true,
  supportsPriceFiltering: true,
  supportsDateRangeSearch: true,
  supportsCancellation: true,
  supportsRefundApi: true,
  requiresLogin: true,
  requiresCaptcha: 'SOMETIMES',
  paymentsAreThirdParty: false,
  maxPassengersPerReservation: 10,
  maxSeatsPerSearch: 50,
};

interface MockReservation {
  ref: string;
  state: ProviderReservationStatus['state'];
  passengers: PassengerInput[];
  total: Money | null;
  holdExpiresAt: Date | null;
}

export class MockProviderAdapter implements ProviderAdapter {
  readonly code: string;
  readonly displayName = 'Mock provider (deterministic)';
  readonly capabilities: ProviderCapabilities;
  readonly timezone = 'UTC';
  readonly compliance = {
    status: 'APPROVED' as const,
    notes: 'In-process deterministic adapter used by tests and local development. No network access.',
  };

  private readonly options: Required<Omit<MockProviderOptions, 'failWith'>> & Pick<MockProviderOptions, 'failWith'>;
  private readonly reservations = new Map<string, MockReservation>();
  private callCount = 0;

  constructor(code = 'mock', options: MockProviderOptions = {}) {
    this.code = code;
    this.options = {
      seed: options.seed ?? 20240912,
      tripsPerRoute: options.tripsPerRoute ?? 4,
      latencyMs: options.latencyMs ?? 0,
      soldOutRate: options.soldOutRate ?? 0,
      failEvery: options.failEvery ?? null,
      currency: options.currency ?? 'IRR',
      failWith: options.failWith,
    };
    this.capabilities = { ...MOCK_CAPABILITIES };
  }

  /** Test hook: forget all reservations between scenarios. */
  reset(): void {
    this.reservations.clear();
    this.callCount = 0;
  }

  async searchAvailability(request: ProviderSearchRequest, context: ProviderCallContext): Promise<ProviderSearchResult> {
    const started = Date.now();
    this.callCount += 1;
    this.maybeFail(context, 'SEARCH');
    await this.sleep();

    const seed = this.seedFor(`${request.originCode}|${request.destinationCode}|${request.departureDate}`);
    const rng = createRng(seed);
    const soldOut = rng() < this.options.soldOutRate;

    const trips: ProviderTrip[] = [];
    for (let index = 0; index < this.options.tripsPerRoute; index += 1) {
      const departureHour = 6 + index * 3;
      const departureAt = new Date(`${request.departureDate}T${String(departureHour).padStart(2, '0')}:15:00.000Z`);
      const arrivalAt = new Date(departureAt.getTime() + (4 + index) * 3_600_000);
      const seats = soldOut ? 0 : Math.max(request.minAvailability ?? 1, Math.floor(rng() * 40));
      const basePrice = 1_800_000 + index * 250_000 + Math.floor(rng() * 100_000);
      const trip: ProviderTrip = {
        providerTripId: `MOCK-${request.originCode}-${request.destinationCode}-${index}`,
        trainNumber: String(100 + index + this.seedFor(request.departureDate) % 100),
        trainName: `Mock Express ${index + 1}`,
        coachClass: request.coachClass === 'ANY' ? 'SECOND' : request.coachClass,
        departureAt: departureAt.toISOString(),
        arrivalAt: arrivalAt.toISOString(),
        durationMinutes: minutesBetween(departureAt.toISOString(), arrivalAt.toISOString()),
        originCode: request.originCode,
        destinationCode: request.destinationCode,
        price: money(basePrice, this.options.currency),
        seatsAvailable: seats,
        seatLabels: seats > 0 ? Array.from({ length: Math.min(seats, 6) }, (_, seat) => `${index + 1}${String(seat + 1).padStart(2, '0')}`) : [],
        fingerprint: '',
        leg: 'OUTBOUND',
      };
      trip.fingerprint = tripFingerprint(trip);
      trips.push(trip);

      if (request.returnDate) {
        const backDeparture = new Date(`${request.returnDate}T${String(departureHour).padStart(2, '0')}:45:00.000Z`);
        const backArrival = new Date(backDeparture.getTime() + (4 + index) * 3_600_000);
        const backSeats = soldOut ? 0 : Math.max(request.minAvailability ?? 1, Math.floor(rng() * 40));
        const back: ProviderTrip = {
          ...trip,
          providerTripId: `MOCK-${request.destinationCode}-${request.originCode}-${index}`,
          departureAt: backDeparture.toISOString(),
          arrivalAt: backArrival.toISOString(),
          durationMinutes: minutesBetween(backDeparture.toISOString(), backArrival.toISOString()),
          seatsAvailable: backSeats,
          price: money(basePrice - 50_000, this.options.currency),
          leg: 'RETURN',
        };
        back.fingerprint = tripFingerprint(back);
        trips.push(back);
      }
    }

    return {
      providerCode: this.code,
      trips,
      durationMs: this.options.latencyMs === 0 ? 1 : Date.now() - started,
      partial: soldOut,
      notices: soldOut ? ['no availability reported for this date'] : [],
    };
  }

  async getTripDetails(tripId: string, context: ProviderCallContext): Promise<ProviderTrip | null> {
    // The mock returns trips only through search; there is no detail endpoint to emulate.
    void tripId;
    void context;
    return null;
  }

  async startReservation(input: ReservationDraftInput, context: ProviderCallContext): Promise<ProviderReservationDraft> {
    this.callCount += 1;
    this.maybeFail(context, 'START_RESERVATION');
    await this.sleep();
    if (input.passengers.length === 0) {
      throw new ProviderCallError('no passengers supplied', this.code, 'VALIDATION', false);
    }
    if (input.passengers.length > this.capabilities.maxPassengersPerReservation) {
      throw new ProviderCallError('too many passengers', this.code, 'VALIDATION', false, {
        max: this.capabilities.maxPassengersPerReservation,
      });
    }

    const ref = `MOCKREF-${uuid().slice(0, 8).toUpperCase()}`;
    const total = money(1_900_000 * input.passengers.length, this.options.currency);
    const holdExpiresAt = new Date(Date.now() + 10 * 60_000);
    this.reservations.set(ref, {
      ref,
      state: 'PENDING',
      passengers: input.passengers,
      total,
      holdExpiresAt,
    });
    return { providerReservationRef: ref, totalPrice: total, holdExpiresAt, requiresHumanStep: false };
  }

  async submitPassengers(
    reservationRef: string,
    passengers: PassengerInput[],
    context: ProviderCallContext,
  ): Promise<ProviderReservationDraft> {
    this.callCount += 1;
    this.maybeFail(context, 'SUBMIT_PASSENGERS');
    await this.sleep();
    const reservation = this.reservations.get(reservationRef);
    if (!reservation) throw new ProviderCallError('unknown reservation', this.code, 'VALIDATION', false);
    reservation.passengers = passengers;
    return {
      providerReservationRef: reservation.ref,
      totalPrice: reservation.total,
      holdExpiresAt: reservation.holdExpiresAt,
      requiresHumanStep: false,
    };
  }

  async holdReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    this.callCount += 1;
    this.maybeFail(context, 'HOLD');
    await this.sleep();
    const reservation = this.requireReservation(reservationRef);
    reservation.state = 'HELD';
    return this.statusOf(reservation);
  }

  async confirmReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    this.callCount += 1;
    this.maybeFail(context, 'CONFIRM');
    await this.sleep();
    const reservation = this.requireReservation(reservationRef);
    reservation.state = 'BOOKED';
    return this.statusOf(reservation);
  }

  async cancelReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    this.callCount += 1;
    this.maybeFail(context, 'CANCEL');
    await this.sleep();
    const reservation = this.requireReservation(reservationRef);
    reservation.state = 'CANCELED';
    return this.statusOf(reservation);
  }

  async getReservationStatus(
    reservationRef: string,
    context: ProviderCallContext,
  ): Promise<ProviderReservationStatus | null> {
    void context;
    const reservation = this.reservations.get(reservationRef);
    return reservation ? this.statusOf(reservation) : null;
  }

  async login(): Promise<never> {
    // The mock needs no session; callers must not treat "no login" as "session valid".
    throw new ProviderCallError('mock provider does not implement login', this.code, 'VALIDATION', false);
  }

  async healthCheck(context: ProviderCallContext): Promise<ProviderHealth> {
    void context;
    return {
      providerCode: this.code,
      ok: true,
      latencyMs: 1,
      errorRate: 0,
      checkedAt: new Date(),
      message: 'deterministic in-process adapter',
    };
  }

  private requireReservation(ref: string): MockReservation {
    const reservation = this.reservations.get(ref);
    if (!reservation) throw new ProviderCallError('unknown reservation', this.code, 'VALIDATION', false);
    return reservation;
  }

  private statusOf(reservation: MockReservation): ProviderReservationStatus {
    return {
      providerReservationRef: reservation.ref,
      state: reservation.state,
      holdExpiresAt: reservation.holdExpiresAt,
      ticketNumbers: reservation.state === 'BOOKED' ? [`${reservation.ref}-1`] : [],
      totalPrice: reservation.total,
    };
  }

  private perhapsFault(operation: string, context: ProviderCallContext): void {
    void operation;
    void context;
  }

  private maybeFail(context: ProviderCallContext, operation: string): void {
    this.perhapsFault(operation, context);
    const every = this.options.failEvery;
    if (every && this.callCount % every === 0) {
      const failureClass = this.options.failWith ?? 'TIMEOUT';
      throw new ProviderCallError(
        `injected ${failureClass} failure on ${operation}`,
        this.code,
        failureClass,
        failureClass === 'TIMEOUT' || failureClass === 'NETWORK' || failureClass === 'RATE_LIMIT',
      );
    }
  }

  private async sleep(): Promise<void> {
    if (this.options.latencyMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
  }

  /** Stable seed from a string, independent of V8's string hash. */
  private seedFor(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash ^ this.options.seed) >>> 0;
  }
}
