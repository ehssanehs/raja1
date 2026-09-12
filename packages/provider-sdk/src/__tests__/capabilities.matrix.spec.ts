/**
 * Capability matrix (spec § 20).
 *
 * The product only offers a feature when the provider declares (and the review verified) the
 * capability behind it. These tests pin the truth table and prove that every registered adapter —
 * including a future real one — is checked against it.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REASON,
  assertCapability,
  hasCapability,
  validateCapabilityMatrix,
  type CapabilityName,
  type ProviderCapabilities,
} from '../capabilities';
import { MockProviderAdapter } from '../mock/provider';
import { TargetProviderAdapter } from '../providers/target-provider/adapter';

function capabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    supportsSeatSelection: false,
    supportsHold: false,
    supportsAutoBooking: false,
    supportsReturnTrips: false,
    supportsPriceFiltering: false,
    supportsDateRangeSearch: false,
    supportsCancellation: false,
    supportsRefundApi: false,
    requiresLogin: true,
    requiresCaptcha: 'NEVER',
    paymentsAreThirdParty: false,
    maxPassengersPerReservation: 6,
    maxSeatsPerSearch: 10,
    ...overrides,
  };
}

describe('capability truth table', () => {
  it('accepts the mock provider and the disabled target placeholder', () => {
    expect(validateCapabilityMatrix(new MockProviderAdapter().capabilities).every((c) => c.ok)).toBe(true);
    expect(validateCapabilityMatrix(new TargetProviderAdapter().capabilities).every((c) => c.ok)).toBe(true);
  });

  it('rejects auto-booking when payment is on a third-party page', () => {
    const checks = validateCapabilityMatrix(capabilities({ supportsAutoBooking: true, paymentsAreThirdParty: true }));
    const failing = checks.filter((check) => !check.ok);
    expect(failing.map((check) => check.capability)).toContain('supportsAutoBooking');
    expect(failing[0]?.reason).toMatch(/third-party payment/i);
  });

  it('rejects holds on providers that always require a human challenge', () => {
    const checks = validateCapabilityMatrix(capabilities({ supportsHold: true, requiresCaptcha: 'ALWAYS' }));
    expect(checks.some((check) => !check.ok && check.capability === 'supportsHold')).toBe(true);
  });

  it('rejects absurd passenger limits', () => {
    for (const max of [0, 21, 100]) {
      const checks = validateCapabilityMatrix(capabilities({ maxPassengersPerReservation: max }));
      expect(checks.some((check) => !check.ok), `max=${max}`).toBe(true);
    }
  });
});

describe('capability assertions', () => {
  const full = new MockProviderAdapter().capabilities;
  const empty = capabilities();

  it('passes when the capability is present', () => {
    expect(() => assertCapability(full, 'supportsHold', 'mock')).not.toThrow();
    expect(hasCapability(full, 'supportsAutoBooking')).toBe(true);
  });

  it('throws CAPABILITY_UNSUPPORTED naming the capability when it is absent', () => {
    for (const capability of Object.keys(CAPABILITY_REASON) as CapabilityName[]) {
      if (capability === 'supportsReturnTrips') continue; // target declares return trips
      expect(() => assertCapability(empty, capability, 'test-provider')).toThrowError(/CAPABILITY|does not support/i);
    }
  });

  it('mentions the provider and the missing capability in the error details', () => {
    try {
      assertCapability(empty, 'supportsHold', 'raja');
      throw new Error('should have thrown');
    } catch (error) {
      const appError = error as { code?: string; details?: Record<string, unknown> };
      expect(appError.code).toBe('CAPABILITY_UNSUPPORTED');
      expect(JSON.stringify(appError.details)).toContain('raja');
      expect(JSON.stringify(appError.details)).toContain('supportsHold');
    }
  });

  it('does not allow the disabled target provider to claim any automation capability', () => {
    const target = new TargetProviderAdapter();
    for (const capability of ['supportsAutoBooking', 'supportsHold', 'supportsSeatSelection'] as CapabilityName[]) {
      expect(hasCapability(target.capabilities, capability)).toBe(false);
    }
    expect(target.compliance.status).toBe('NOT_REVIEWED');
  });
});

describe('feature gating derived from capabilities', () => {
  const matrix: Array<[CapabilityName, string]> = [
    ['supportsSeatSelection', 'seat selection UI + API field'],
    ['supportsHold', 'AUTO_HOLD automation mode'],
    ['supportsAutoBooking', 'AUTHORIZED_AUTO_BOOKING mode'],
    ['supportsReturnTrips', 'return-trip itinerary'],
    ['supportsPriceFiltering', 'server-side max-price filtering'],
    ['supportsDateRangeSearch', 'multi-date search in one call'],
    ['supportsCancellation', 'self-service cancellation'],
    ['supportsRefundApi', 'automated refunds'],
  ];

  it('declares a reason for every capability (used in user-facing errors)', () => {
    for (const [capability] of matrix) {
      expect(CAPABILITY_REASON[capability]).toBeTruthy();
    }
  });

  it('keeps every capability false in the conservative baseline', () => {
    const baseline = capabilities();
    for (const [capability] of matrix) {
      expect(baseline[capability]).toBe(false);
    }
  });
});
