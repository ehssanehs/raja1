/**
 * Provider-facing domain types.
 *
 * These types are deliberately *provider neutral*: adapters translate their own payloads into these
 * shapes, and everything above the adapter (matching, scoring, booking) works with them only. This
 * keeps provider-specific code inside one folder per provider (spec § 20).
 */
import type { Money, CoachClass, SeatPreference, FailureClass } from '@raja/shared';
import type { ProviderCapabilities } from './capabilities';

export interface ProviderSession {
  /** Opaque id of our stored session row (never the provider's cookie value). */
  sessionId: string;
  providerCode: string;
  /** Account label, never the username/password. */
  accountLabel: string;
  /** When the session was validated last. */
  validatedAt: Date;
  /** True when the provider told us the session is still good. */
  valid: boolean;
}

export interface ProviderSearchRequest {
  originCode: string;
  destinationCode: string;
  /** Provider-local date (the provider's calendar), not a UTC instant. */
  departureDate: string;
  returnDate?: string;
  passengers: number;
  coachClass: CoachClass;
  seatPreference: SeatPreference;
  maxPriceMinor?: number;
  minAvailability?: number;
  /** Preferred departure window in provider-local time (HH:mm). */
  preferredDepartureFrom?: string;
  preferredDepartureTo?: string;
  /** Provider trip ids / train numbers to prioritise (from user preferences). */
  preferredTripIds?: string[];
  corridorHint?: string;
}

export interface ProviderTrip {
  providerTripId: string;
  trainNumber: string;
  trainName: string;
  coachClass: CoachClass;
  /** UTC instants. Adapters convert from provider-local wall clock exactly once. */
  departureAt: string;
  arrivalAt: string | null;
  durationMinutes: number | null;
  originCode: string;
  destinationCode: string;
  price: Money | null;
  seatsAvailable: number;
  seatLabels: string[];
  /** Stable identity of this offer: used for change detection and duplicate suppression. */
  fingerprint: string;
  /** Return-leg trips are tagged so matching can pair them. */
  leg: 'OUTBOUND' | 'RETURN';
}

export interface ProviderSearchResult {
  providerCode: string;
  trips: ProviderTrip[];
  /** Provider-reported timing, used for health scoring. */
  durationMs: number;
  /** Set when the provider answered but with a partial/limited result set. */
  partial: boolean;
  /** Provider-side warnings that are safe to surface (already sanitized). */
  notices: string[];
}

export interface PassengerInput {
  firstName: string;
  lastName: string;
  /** Encrypted at rest by the caller; adapters only ever see plaintext in memory. */
  nationalId?: string;
  passportNumber?: string;
  birthDate?: string;
  gender?: 'MALE' | 'FEMALE';
}

export interface ReservationDraftInput {
  tripId: string;
  passengers: PassengerInput[];
  coachClass: CoachClass;
  seatLabels?: string[];
  /** Contact details the provider requires for the ticket. */
  contact?: { phone?: string; email?: string };
}

export interface ProviderReservationDraft {
  providerReservationRef: string;
  /** Human-readable total as reported by the provider. */
  totalPrice: Money | null;
  /** When the provider will release an unpaid hold. */
  holdExpiresAt: Date | null;
  /** True when the provider requires a human step (payment, OTP, CAPTCHA) to continue. */
  requiresHumanStep: boolean;
  /** Where the human must go, if applicable (already sanitized URL of the payment page). */
  humanStepUrl?: string;
  /** Payment amount due on the provider side (mirrors totalPrice when present). */
  amountDue?: Money | null;
}

export interface ProviderReservationStatus {
  providerReservationRef: string;
  state: 'PENDING' | 'HELD' | 'RESERVED' | 'BOOKED' | 'EXPIRED' | 'CANCELED' | 'FAILED';
  holdExpiresAt: Date | null;
  ticketNumbers: string[];
  totalPrice: Money | null;
}

export interface ProviderHealth {
  providerCode: string;
  ok: boolean;
  latencyMs: number | null;
  /** Provider-declared or measured error rate (0..1) if known. */
  errorRate: number | null;
  checkedAt: Date;
  message?: string;
}

export interface ProviderCallContext {
  correlationId: string;
  tenantId: string;
  /** Session/account to use. Adapters never choose accounts themselves (the pool assigns). */
  accountId: string | null;
  /**
   * Egress proxy leased by the worker for this call (see @raja/proxy, docs/proxy-pool.md).
   * When present, the adapter MUST bind its HTTP/browser transport to this proxy id for the
   * whole call, and MUST NOT switch egress when the provider signals a restriction — the pool
   * handles rest/recovery. When absent, use the platform's direct egress (or refuse in
   * `egressMode=REQUIRED`; the worker enforces that before the call is made).
   */
  egressProxyId?: string | null;
  /** Hard deadline for the whole attempt (ms). */
  timeoutMs: number;
  /** Signals that the caller is a burst-validation/warm-up call (no booking allowed). */
  purpose?: 'SEARCH' | 'WARMUP' | 'BURST_VALIDATION' | 'BOOKING' | 'STATUS';
  /** Cancellation support. */
  abortSignal?: AbortSignal;
}

export interface ProviderCompliance {
  status: 'APPROVED' | 'NOT_REVIEWED' | 'PROHIBITED';
  notes: string;
  /** Operations that remain blocked even when approved (e.g. payment on a third-party page). */
  blockedOperations?: string[];
}

export interface ProviderAdapter {
  readonly code: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly compliance: ProviderCompliance;
  /** Provider-local timezone used to interpret dates and times. */
  readonly timezone: string;

  searchAvailability(request: ProviderSearchRequest, context: ProviderCallContext): Promise<ProviderSearchResult>;
  getTripDetails?(tripId: string, context: ProviderCallContext): Promise<ProviderTrip | null>;

  startReservation?(input: ReservationDraftInput, context: ProviderCallContext): Promise<ProviderReservationDraft>;
  submitPassengers?(
    reservationRef: string,
    passengers: PassengerInput[],
    context: ProviderCallContext,
  ): Promise<ProviderReservationDraft>;
  holdReservation?(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus>;
  confirmReservation?(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus>;
  cancelReservation?(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus>;
  getReservationStatus(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus | null>;

  login?(accountId: string, credentials: { username: string; password: string }, context: ProviderCallContext): Promise<ProviderSession>;
  validateSession?(session: ProviderSession, context: ProviderCallContext): Promise<boolean>;
  refreshSession?(session: ProviderSession, context: ProviderCallContext): Promise<ProviderSession>;
  logout?(session: ProviderSession, context: ProviderCallContext): Promise<void>;

  healthCheck(context: ProviderCallContext): Promise<ProviderHealth>;
}

/** Provider-surfaced failure, already mapped to our failure taxonomy. */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly providerCode: string,
    readonly failureClass: FailureClass,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }
}
