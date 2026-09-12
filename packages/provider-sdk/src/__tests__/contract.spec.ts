/**
 * Provider contract suite.
 *
 * Every adapter — mock, simulator, and any future real adapter — must pass this suite. It encodes
 * the promises the booking domain relies on, so a new adapter cannot ship "working" code that
 * breaks matching, dedupe or the state machine.
 *
 * The suite is exported so the provider-simulator app and future adapters can reuse it.
 */
import { describe, expect, it } from 'vitest';
import { MockProviderAdapter } from '../mock/provider';
import { TargetProviderAdapter } from '../providers/target-provider/adapter';
import { validateCapabilityMatrix, hasCapability } from '../capabilities';
import { dedupeTrips } from '../normalize';
import type { ProviderAdapter, ProviderCallContext, ProviderSearchRequest } from '../types';

export interface ContractSubject {
  name: string;
  create: () => ProviderAdapter;
  /**
   * `refuses` subjects are adapters that must never touch a provider (the disabled placeholder for
   * an unreviewed real provider). They still have to satisfy the *shape* of the contract: every
   * method exists, declares honest capabilities, and fails closed with COMPLIANCE_BLOCKED.
   */
  mode?: 'full' | 'refuses';
}

export function describeProviderContract(subject: ContractSubject): void {
  const contextFor = (purpose: ProviderCallContext['purpose'] = 'SEARCH'): ProviderCallContext => ({
    correlationId: 'contract-test',
    tenantId: '00000000-0000-4000-8000-0000000000a1',
    accountId: null,
    timeoutMs: 5_000,
    purpose,
  });

  const request = (overrides: Partial<ProviderSearchRequest> = {}): ProviderSearchRequest => ({
    originCode: 'THR',
    destinationCode: 'MHD',
    departureDate: '2026-03-01',
    passengers: 1,
    coachClass: 'ANY',
    seatPreference: 'ANY',
    minAvailability: 1,
    ...overrides,
  });

  const mode = subject.mode ?? 'full';

  describe(`${subject.name}: contract`, () => {
    it('declares a consistent capability matrix', () => {
      const adapter = subject.create();
      expect(validateCapabilityMatrix(adapter.capabilities).filter((check) => !check.ok)).toEqual([]);
      if (mode === 'refuses') {
        // A disabled provider must not claim automation in its capability declaration.
        expect(adapter.compliance.status).not.toBe('APPROVED');
        expect(adapter.capabilities.supportsAutoBooking).toBe(false);
      }
    });

    if (mode === 'refuses') {
      it('refuses every operation with COMPLIANCE_BLOCKED', async () => {
        const adapter = subject.create();
        await expect(adapter.searchAvailability(request(), contextFor())).rejects.toMatchObject({
          code: 'COMPLIANCE_BLOCKED',
        });
        if (adapter.startReservation) {
          await expect(
            adapter.startReservation({ tripId: 'x', passengers: [{ firstName: 'A', lastName: 'B' }], coachClass: 'ANY' }, contextFor('BOOKING')),
          ).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
        }
        if (adapter.getReservationStatus) {
          await expect(adapter.getReservationStatus('x', contextFor('STATUS'))).rejects.toMatchObject({
            code: 'COMPLIANCE_BLOCKED',
          });
        }
        const health = await adapter.healthCheck(contextFor());
        expect(health.ok).toBe(false);
        expect(health.message).toMatch(/disabled|not approved|review/i);
        return;
      });
      return;
    }


    it('returns normalized trips for the requested route', async () => {
      const adapter = subject.create();
      const result = await adapter.searchAvailability(request(), contextFor());
      expect(result.providerCode).toBe(adapter.code);
      for (const trip of result.trips) {
        expect(trip.originCode).toBe('THR');
        expect(trip.destinationCode).toBe('MHD');
        expect(trip.fingerprint).toMatch(/^[0-9a-f]{32}$/);
        expect(Date.parse(trip.departureAt)).not.toBeNaN();
        expect(trip.seatsAvailable).toBeGreaterThanOrEqual(0);
        if (trip.price) {
          expect(Number.isInteger(trip.price.amountMinor)).toBe(true);
          expect(trip.price.currency).toHaveLength(3);
        }
      }
      // Trips are already deduplicated by the adapter.
      expect(dedupeTrips(result.trips)).toHaveLength(result.trips.length);
    });

    it('is deterministic for identical requests (fingerprints are stable)', async () => {
      const adapter = subject.create();
      const first = await adapter.searchAvailability(request(), contextFor());
      const second = await adapter.searchAvailability(request(), contextFor());
      expect(second.trips.map((trip) => trip.fingerprint)).toEqual(first.trips.map((trip) => trip.fingerprint));
    });

    it('only returns a return leg when one was requested, and only if supported', async () => {
      const adapter = subject.create();
      const withoutReturn = await adapter.searchAvailability(request(), contextFor());
      expect(withoutReturn.trips.every((trip) => trip.leg === 'OUTBOUND')).toBe(true);

      const withReturn = await adapter.searchAvailability(
        request({ returnDate: '2026-03-08' }),
        contextFor(),
      );
      if (hasCapability(adapter.capabilities, 'supportsReturnTrips')) {
        expect(withReturn.trips.some((trip) => trip.leg === 'RETURN')).toBe(true);
      } else {
        expect(withReturn.trips.every((trip) => trip.leg === 'OUTBOUND')).toBe(true);
      }
    });

    it('never leaks identifiers in provider notices', async () => {
      const adapter = subject.create();
      const result = await adapter.searchAvailability(request(), contextFor());
      for (const notice of result.notices) {
        expect(notice).not.toMatch(/\b\d{10}\b/); // national id
        expect(notice).not.toMatch(/password|cookie|token=/i);
      }
    });

    it('refuses optional operations it does not declare', async () => {
      const adapter = subject.create();
      if (!hasCapability(adapter.capabilities, 'supportsHold') && adapter.holdReservation) {
        await expect(adapter.holdReservation('any-ref', contextFor('BOOKING'))).rejects.toMatchObject({
          code: 'COMPLIANCE_BLOCKED',
        });
      }
      if (!hasCapability(adapter.capabilities, 'supportsCancellation') && adapter.cancelReservation) {
        await expect(adapter.cancelReservation('any-ref', contextFor('BOOKING'))).rejects.toMatchObject({
          code: 'COMPLIANCE_BLOCKED',
        });
      }
    });

    it('supports a full reservation lifecycle when it declares the capabilities', async () => {
      const adapter = subject.create();
      if (!adapter.startReservation || !hasCapability(adapter.capabilities, 'supportsHold')) return;

      const draft = await adapter.startReservation(
        {
          tripId: 'MOCK-THR-MHD-0',
          passengers: [{ firstName: 'Test', lastName: 'User' }],
          coachClass: 'SECOND',
        },
        contextFor('BOOKING'),
      );
      expect(draft.providerReservationRef).toBeTruthy();

      const held = await adapter.holdReservation?.(draft.providerReservationRef, contextFor('BOOKING'));
      expect(['HELD', 'PENDING', 'RESERVED']).toContain(held?.state);

      if (adapter.confirmReservation && hasCapability(adapter.capabilities, 'supportsAutoBooking')) {
        const booked = await adapter.confirmReservation(draft.providerReservationRef, contextFor('BOOKING'));
        expect(booked.state).toBe('BOOKED');
        const status = await adapter.getReservationStatus(draft.providerReservationRef, contextFor('STATUS'));
        expect(status?.state).toBe('BOOKED');
      }
    });

    it('rejects more passengers than the provider allows', async () => {
      const adapter = subject.create();
      if (!adapter.startReservation) return;
      const tooMany = Array.from({ length: adapter.capabilities.maxPassengersPerReservation + 1 }, (_, index) => ({
        firstName: `P${index}`,
        lastName: 'Test',
      }));
      await expect(
        adapter.startReservation({ tripId: 'x', passengers: tooMany, coachClass: 'ANY' }, contextFor('BOOKING')),
      ).rejects.toThrow(/too many|maximum|validation/i);
    });

    it('reports health without performing a booking', async () => {
      const adapter = subject.create();
      const health = await adapter.healthCheck(contextFor());
      expect(health.providerCode).toBe(adapter.code);
      expect(typeof health.ok).toBe('boolean');
      expect(health.checkedAt).toBeInstanceOf(Date);
    });
  });
}

// The mock provider is the reference implementation of the contract.
describeProviderContract({ name: 'mock', create: () => new MockProviderAdapter() });

// The disabled target provider runs the same suite in its "refuses everything" mode.
describeProviderContract({
  name: 'target-provider (disabled)',
  create: () => new TargetProviderAdapter(),
  mode: 'refuses',
});

describe('contract suite coverage', () => {
  it('runs against every adapter the platform can load today', () => {
    const factories = [() => new MockProviderAdapter(), () => new TargetProviderAdapter()];
    for (const factory of factories) {
      expect(validateCapabilityMatrix(factory().capabilities).filter((check) => !check.ok)).toEqual([]);
    }
  });
});
