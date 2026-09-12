/**
 * Target provider adapter — DISABLED PLACEHOLDER.
 *
 * Nothing in this file talks to a provider. Every method throws `NotApprovedError`, so even a
 * misconfiguration that somehow enables this adapter cannot place traffic, log in, search or book.
 *
 * This is intentional and covered by `capabilities.matrix.spec.ts`: the "disabled adapter never
 * performs work" test asserts that each method rejects before any I/O could happen.
 *
 * See ./README.md for the gates that must be passed first (docs/provider-research.md § 8, G1–G10).
 */
import { AppError } from '@raja/shared';
import type { ProviderCapabilities } from '../../capabilities';
import type {
  ProviderAdapter,
  ProviderCallContext,
  ProviderHealth,
  ProviderReservationDraft,
  ProviderReservationStatus,
  ProviderSearchRequest,
  ProviderSearchResult,
  ProviderSession,
  PassengerInput,
  ProviderTrip,
  ReservationDraftInput,
} from '../../types';

export class NotApprovedError extends AppError {
  constructor(operation: string, providerCode: string) {
    super('COMPLIANCE_BLOCKED', `${providerCode} automation is not approved (operation: ${operation})`, {
      userMessageKey: 'error.compliance_blocked',
      details: { operation, providerCode, gate: 'docs/provider-research.md § 8 (G1–G10)' },
    });
    this.name = 'NotApprovedError';
  }
}

/**
 * Conservative capability declaration. Nothing is claimed except what the public research
 * established (return-trip search exists; payment is on a third-party bank page), and everything
 * that would enable automation is `false`.
 */
export const TARGET_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  supportsSeatSelection: false,
  supportsHold: false,
  supportsAutoBooking: false,
  supportsReturnTrips: true,
  supportsPriceFiltering: false,
  supportsDateRangeSearch: false,
  supportsCancellation: false,
  supportsRefundApi: false,
  requiresLogin: true,
  requiresCaptcha: 'UNKNOWN',
  paymentsAreThirdParty: true,
  maxPassengersPerReservation: 6,
  maxSeatsPerSearch: 0,
};

export class TargetProviderAdapter implements ProviderAdapter {
  readonly code: string;
  readonly displayName: string;
  readonly capabilities = TARGET_PROVIDER_CAPABILITIES;
  readonly timezone = 'Asia/Tehran';
  readonly compliance = {
    status: 'NOT_REVIEWED' as const,
    notes:
      'Automation not approved. Gate checklist G1–G10 incomplete (docs/provider-research.md § 8). ' +
      'Adapter is a disabled placeholder; no endpoint, selector or session flow is implemented.',
    blockedOperations: ['START_RESERVATION', 'SUBMIT_PASSENGERS', 'HOLD', 'CONFIRM', 'AUTO_BOOK', 'CANCEL', 'REFUND', 'LOGIN'],
  };

  constructor(code = 'target-provider', displayName = 'Target provider (disabled)') {
    this.code = code;
    this.displayName = displayName;
  }

  async searchAvailability(request: ProviderSearchRequest, context: ProviderCallContext): Promise<ProviderSearchResult> {
    void request;
    void context;
    throw new NotApprovedError('SEARCH', this.code);
  }

  async getTripDetails(tripId: string, context: ProviderCallContext): Promise<ProviderTrip | null> {
    void tripId;
    void context;
    throw new NotApprovedError('VIEW_TRIP', this.code);
  }

  async startReservation(input: ReservationDraftInput, context: ProviderCallContext): Promise<ProviderReservationDraft> {
    void input;
    void context;
    throw new NotApprovedError('START_RESERVATION', this.code);
  }

  async submitPassengers(
    reservationRef: string,
    passengers: PassengerInput[],
    context: ProviderCallContext,
  ): Promise<ProviderReservationDraft> {
    void reservationRef;
    void passengers;
    void context;
    throw new NotApprovedError('SUBMIT_PASSENGERS', this.code);
  }

  async holdReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    void reservationRef;
    void context;
    throw new NotApprovedError('HOLD', this.code);
  }

  async confirmReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    void reservationRef;
    void context;
    throw new NotApprovedError('CONFIRM', this.code);
  }

  async cancelReservation(reservationRef: string, context: ProviderCallContext): Promise<ProviderReservationStatus> {
    void reservationRef;
    void context;
    throw new NotApprovedError('CANCEL', this.code);
  }

  async getReservationStatus(
    reservationRef: string,
    context: ProviderCallContext,
  ): Promise<ProviderReservationStatus | null> {
    void reservationRef;
    void context;
    throw new NotApprovedError('STATUS', this.code);
  }

  async login(
    accountId: string,
    credentials: { username: string; password: string },
    context: ProviderCallContext,
  ): Promise<ProviderSession> {
    void accountId;
    void credentials;
    void context;
    throw new NotApprovedError('LOGIN', this.code);
  }

  async validateSession(session: ProviderSession, context: ProviderCallContext): Promise<boolean> {
    void session;
    void context;
    throw new NotApprovedError('VALIDATE_SESSION', this.code);
  }

  async refreshSession(session: ProviderSession, context: ProviderCallContext): Promise<ProviderSession> {
    void session;
    void context;
    throw new NotApprovedError('REFRESH_SESSION', this.code);
  }

  async logout(session: ProviderSession, context: ProviderCallContext): Promise<void> {
    void session;
    void context;
    throw new NotApprovedError('LOGOUT', this.code);
  }

  /** Health checks are allowed: they only report that the adapter refuses to run. */
  async healthCheck(context: ProviderCallContext): Promise<ProviderHealth> {
    void context;
    return {
      providerCode: this.code,
      ok: false,
      latencyMs: null,
      errorRate: null,
      checkedAt: new Date(),
      message: 'adapter disabled: compliance review not passed',
    };
  }
}
