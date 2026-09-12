/**
 * Provider capability model (spec § 20, docs/provider-adapter.md).
 *
 * Capabilities are *declared by the adapter* and *verified by tests*. Product features are gated on
 * them, never on `if (provider === 'x')`: a plan may allow seat selection, but if the provider
 * cannot select seats the UI and the API must say so honestly instead of failing halfway through a
 * booking.
 */
import { AppError, capabilityUnsupported } from '@raja/shared';

export type CaptchaFrequency = 'NEVER' | 'SOMETIMES' | 'ALWAYS' | 'UNKNOWN';

export interface ProviderCapabilities {
  /** Can the adapter pick specific seats/berths? */
  supportsSeatSelection: boolean;
  /** Can a reservation be held (without full payment) and released later? */
  supportsHold: boolean;
  /** Is unattended submission permitted *by the provider*? Compliance still gates enabling it. */
  supportsAutoBooking: boolean;
  /** Return-trip itinerary search in a single request. */
  supportsReturnTrips: boolean;
  /** Server-side price filtering (as opposed to filtering results client-side). */
  supportsPriceFiltering: boolean;
  /** Search across a date range in one request. */
  supportsDateRangeSearch: boolean;
  /** Cancellation through the adapter. */
  supportsCancellation: boolean;
  /** Refunds are handled by an API rather than by human/back-office process. */
  supportsRefundApi: boolean;
  /** Provider requires an authenticated session for search (not just for booking). */
  requiresLogin: boolean;
  /** How often the provider presents a human-verification challenge. */
  requiresCaptcha: CaptchaFrequency;
  /** Payment happens on a third-party page (bank/PSP) outside our control. */
  paymentsAreThirdParty: boolean;
  /** Provider-side limit that the validator must respect. */
  maxPassengersPerReservation: number;
  /** Maximum seats we may request in one search; 0 = unknown/unbounded. */
  maxSeatsPerSearch: number;
}

/** Named capabilities that product features depend on. */
export type CapabilityName = keyof Pick<
  ProviderCapabilities,
  | 'supportsSeatSelection'
  | 'supportsHold'
  | 'supportsAutoBooking'
  | 'supportsReturnTrips'
  | 'supportsPriceFiltering'
  | 'supportsDateRangeSearch'
  | 'supportsCancellation'
  | 'supportsRefundApi'
>;

/** Human-readable reason used in error details and in the UI (i18n key per capability). */
export const CAPABILITY_REASON: Record<CapabilityName, string> = {
  supportsSeatSelection: 'this provider cannot select specific seats',
  supportsHold: 'this provider cannot hold a reservation',
  supportsAutoBooking: 'this provider does not permit unattended booking',
  supportsReturnTrips: 'this provider does not support return-trip requests',
  supportsPriceFiltering: 'this provider cannot filter by price server-side',
  supportsDateRangeSearch: 'this provider cannot search a date range',
  supportsCancellation: 'this provider does not support cancellation through the adapter',
  supportsRefundApi: 'this provider has no refund API',
};

export function hasCapability(capabilities: ProviderCapabilities, capability: CapabilityName): boolean {
  return capabilities[capability] === true;
}

export function assertCapability(
  capabilities: ProviderCapabilities,
  capability: CapabilityName,
  providerCode = 'provider',
): void {
  if (!hasCapability(capabilities, capability)) {
    throw capabilityUnsupported(capability, `${providerCode} (${CAPABILITY_REASON[capability]})`);
  }
}

export interface CapabilityMatrixCheck {
  capability: CapabilityName;
  ok: boolean;
  reason?: string;
}

/**
 * Consistency checks that must hold for *any* adapter, whatever the provider. These are asserted in
 * `capabilities.matrix.spec.ts` for every registered adapter, including the mock.
 */
export function validateCapabilityMatrix(capabilities: ProviderCapabilities): CapabilityMatrixCheck[] {
  const checks: CapabilityMatrixCheck[] = [];
  const push = (capability: CapabilityName, ok: boolean, reason?: string): void => {
    checks.push(reason === undefined ? { capability, ok } : { capability, ok, reason });
  };

  // Unattended booking implies the provider can be driven without a human in the middle of the
  // payment step; a third-party payment page makes that impossible in practice.
  push(
    'supportsAutoBooking',
    !(capabilities.supportsAutoBooking && capabilities.paymentsAreThirdParty),
    'a provider with third-party payment cannot claim unattended auto-booking',
  );
  // Holding implies the ability to start and later abandon a reservation.
  push(
    'supportsHold',
    !(capabilities.supportsHold && capabilities.requiresCaptcha === 'ALWAYS'),
    'a provider that always requires a human challenge cannot support holds',
  );
  // Seat selection without search is meaningless.
  push('supportsSeatSelection', !capabilities.supportsSeatSelection || capabilities.requiresLogin === true, undefined);
  // Limits must be sane.
  push(
    'supportsAutoBooking',
    capabilities.maxPassengersPerReservation >= 1 && capabilities.maxPassengersPerReservation <= 20,
    'maxPassengersPerReservation must be between 1 and 20',
  );

  return checks;
}

/** Capabilities a *known* provider code may never claim before an approved compliance review. */
export const AUTOMATION_CAPABILITIES: readonly CapabilityName[] = ['supportsAutoBooking'];

export function assertNoUnsafeAutomation(capabilities: ProviderCapabilities, providerCode: string): void {
  if (capabilities.supportsAutoBooking && capabilities.paymentsAreThirdParty) {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      `provider ${providerCode} declares auto-booking while payments are third-party`,
      { userMessageKey: 'error.capability_unsupported', details: { providerCode } },
    );
  }
}
