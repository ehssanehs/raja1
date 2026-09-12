/**
 * Compliance gate (docs/provider-research.md § 8, ADR-0005).
 *
 * The gate is the difference between "we have a policy" and "the policy is enforced". These tests
 * pin the four regimes: PROHIBITED, NOT_REVIEWED, APPROVED and dry-run.
 */
import { describe, expect, it } from 'vitest';
import { assertAdapterOperationAllowed, assertOperationAllowed, evaluateOperation } from '../compliance';
import { MockProviderAdapter } from '../mock/provider';
import { TargetProviderAdapter } from '../providers/target-provider/adapter';

const NOT_REVIEWED = { status: 'NOT_REVIEWED' as const, notes: 'pending review' };
const APPROVED = { status: 'APPROVED' as const, notes: 'reviewed' };
const PROHIBITED = { status: 'PROHIBITED' as const, notes: 'forbidden by policy' };

describe('compliance regimes', () => {
  it('blocks everything for a PROHIBITED provider', () => {
    for (const operation of ['SEARCH', 'START_RESERVATION', 'AUTO_BOOK', 'LOGIN'] as const) {
      expect(evaluateOperation(PROHIBITED, operation, { dryRun: false }).allowed, operation).toBe(false);
    }
  });

  it('allows read-only operations for a NOT_REVIEWED provider', () => {
    expect(evaluateOperation(NOT_REVIEWED, 'SEARCH', { dryRun: false }).allowed).toBe(true);
    expect(evaluateOperation(NOT_REVIEWED, 'VIEW_TRIP', { dryRun: false }).allowed).toBe(true);
    expect(evaluateOperation(NOT_REVIEWED, 'HEALTH_CHECK', { dryRun: false }).allowed).toBe(true);
    expect(evaluateOperation(NOT_REVIEWED, 'LOGIN', { dryRun: false }).allowed).toBe(false);
    expect(evaluateOperation(NOT_REVIEWED, 'START_RESERVATION', { dryRun: false }).allowed).toBe(false);
    expect(evaluateOperation(NOT_REVIEWED, 'AUTO_BOOK', { dryRun: false }).allowed).toBe(false);
  });

  it('allows approved writes but keeps automation behind its feature flag', () => {
    expect(evaluateOperation(APPROVED, 'START_RESERVATION', { dryRun: false }).allowed).toBe(true);
    expect(evaluateOperation(APPROVED, 'HOLD', { dryRun: false }).allowed).toBe(true);
    expect(evaluateOperation(APPROVED, 'AUTO_BOOK', { dryRun: false }).allowed).toBe(false);
    expect(evaluateOperation(APPROVED, 'AUTO_BOOK', { dryRun: false, automationEnabled: true }).allowed).toBe(true);
    expect(evaluateOperation(APPROVED, 'CONFIRM', { dryRun: false, automationEnabled: true }).allowed).toBe(true);
  });

  it('makes dry-run a real guarantee for an approved provider', () => {
    for (const operation of ['LOGIN', 'START_RESERVATION', 'SUBMIT_PASSENGERS', 'HOLD', 'CANCEL', 'REFUND'] as const) {
      const decision = evaluateOperation(APPROVED, operation, { dryRun: true });
      expect(decision.allowed, operation).toBe(false);
      expect(decision.reason).toMatch(/dry-run/i);
    }
    // Reads are still allowed in dry-run — that is the whole point of monitoring.
    expect(evaluateOperation(APPROVED, 'SEARCH', { dryRun: true }).allowed).toBe(true);
  });

  it('honours the kill switch above everything else', () => {
    expect(evaluateOperation(APPROVED, 'SEARCH', { dryRun: false, killSwitch: true }).allowed).toBe(false);
    expect(evaluateOperation(APPROVED, 'SEARCH', { dryRun: true, killSwitch: true }).reason).toMatch(/kill switch/i);
  });

  it('honours per-provider blocked operations', () => {
    const blocked = { status: 'APPROVED' as const, notes: 'approved except refunds', blockedOperations: ['REFUND'] };
    expect(evaluateOperation(blocked, 'REFUND', { dryRun: false }).allowed).toBe(false);
    expect(evaluateOperation(blocked, 'CANCEL', { dryRun: false }).allowed).toBe(true);
  });
});

describe('assertions used by the booking path', () => {
  it('throws DRY_RUN_BLOCKED for writes in dry-run and names the provider', () => {
    try {
      assertOperationAllowed(APPROVED, 'HOLD', { dryRun: true }, 'mock');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('DRY_RUN_BLOCKED');
      expect((error as Error).message).toContain('mock');
    }
  });

  it('throws COMPLIANCE_BLOCKED with the reason for unreviewed automation', () => {
    try {
      assertOperationAllowed(NOT_REVIEWED, 'AUTO_BOOK', { dryRun: false, automationEnabled: true }, 'raja');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('COMPLIANCE_BLOCKED');
      expect((error as Error).message).toMatch(/not approved|compliance/i);
      expect(JSON.stringify((error as { details?: unknown }).details)).toMatch(/G1|8/);
    }
  });

  it('lets the mock provider run reads but not unattended automation without a flag', () => {
    const mock = new MockProviderAdapter();
    expect(() => assertAdapterOperationAllowed(mock, 'SEARCH', { dryRun: true })).not.toThrow();
    expect(() => assertAdapterOperationAllowed(mock, 'SUBMIT_PASSENGERS', { dryRun: true })).toThrowError(/dry-run/i);
    expect(() => assertAdapterOperationAllowed(mock, 'AUTO_BOOK', { dryRun: false })).toThrowError(/feature flag/i);
  });

  it('keeps the disabled target adapter from doing anything but reads', () => {
    const target = new TargetProviderAdapter('raja');
    expect(() => assertAdapterOperationAllowed(target, 'SEARCH', { dryRun: true })).not.toThrow();
    expect(() => assertAdapterOperationAllowed(target, 'START_RESERVATION', { dryRun: false })).toThrowError(
      /not approved|compliance/i,
    );
    expect(() => assertAdapterOperationAllowed(target, 'LOGIN', { dryRun: false })).toThrowError(
      /not approved|compliance/i,
    );
  });
});
