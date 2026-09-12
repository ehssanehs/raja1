/**
 * The compliance gate (docs/provider-research.md § 8, ADR-0005).
 *
 * This is the single place where "may we actually do this against this provider?" is decided.
 * Everything else in the codebase asks this module instead of re-deciding.
 *
 *   PROHIBITED   → no automation at all, not even search
 *   NOT_REVIEWED → read-only search (what the monitoring feature needs), never a write
 *   APPROVED     → writes allowed, and automation additionally requires the capability and the
 *                  runtime feature flags checked by the booking service
 *
 * Dry-run is orthogonal and stricter: in dry-run, *no* write or automation operation is executed,
 * even against an APPROVED provider. That is what makes `DRY_RUN=true` a real guarantee rather than
 * a convention.
 */
import { complianceBlocked, dryRunBlocked, AppError } from '@raja/shared';
import type { ProviderAdapter, ProviderCompliance } from './types';

export type ProviderOperation =
  | 'SEARCH'
  | 'VIEW_TRIP'
  | 'HEALTH_CHECK'
  | 'LOGIN'
  | 'START_RESERVATION'
  | 'SUBMIT_PASSENGERS'
  | 'HOLD'
  | 'CONFIRM'
  | 'AUTO_BOOK'
  | 'CANCEL'
  | 'REFUND';

export type OperationRisk = 'READ' | 'WRITE' | 'AUTOMATION';

export const OPERATION_RISK: Record<ProviderOperation, OperationRisk> = {
  SEARCH: 'READ',
  VIEW_TRIP: 'READ',
  HEALTH_CHECK: 'READ',
  LOGIN: 'WRITE',
  START_RESERVATION: 'WRITE',
  SUBMIT_PASSENGERS: 'WRITE',
  HOLD: 'WRITE',
  CONFIRM: 'AUTOMATION',
  AUTO_BOOK: 'AUTOMATION',
  CANCEL: 'WRITE',
  REFUND: 'WRITE',
};

export interface ComplianceContext {
  dryRun: boolean;
  /** Global kill switch: when true nothing may run against providers at all. */
  killSwitch?: boolean;
  /** Per-operation allow list from feature flags (checked by the caller, passed through here). */
  automationEnabled?: boolean;
}

export interface ComplianceDecision {
  allowed: boolean;
  risk: OperationRisk;
  reason?: string;
}

export function evaluateOperation(
  compliance: ProviderCompliance,
  operation: ProviderOperation,
  context: ComplianceContext,
): ComplianceDecision {
  const risk = OPERATION_RISK[operation];

  if (context.killSwitch) {
    return { allowed: false, risk, reason: 'booking kill switch is active' };
  }
  if (compliance.status === 'PROHIBITED') {
    return { allowed: false, risk, reason: `provider compliance status is PROHIBITED (${compliance.notes})` };
  }
  if (compliance.blockedOperations?.includes(operation)) {
    return { allowed: false, risk, reason: `operation ${operation} is explicitly blocked for this provider` };
  }
  if (compliance.status === 'NOT_REVIEWED' && risk !== 'READ') {
    return {
      allowed: false,
      risk,
      reason: 'provider automation has not passed the compliance review (docs/provider-research.md § 8)',
    };
  }
  if (context.dryRun && risk !== 'READ') {
    return { allowed: false, risk, reason: `dry-run mode: ${operation} would touch the provider` };
  }
  if (risk === 'AUTOMATION' && context.automationEnabled !== true) {
    return { allowed: false, risk, reason: 'unattended automation is disabled by feature flag' };
  }
  return { allowed: true, risk };
}

export function assertOperationAllowed(
  compliance: ProviderCompliance,
  operation: ProviderOperation,
  context: ComplianceContext,
  providerCode = 'provider',
): void {
  const decision = evaluateOperation(compliance, operation, context);
  if (decision.allowed) return;

  if (decision.risk !== 'READ' && context.dryRun) {
    throw dryRunBlocked(`${operation} against provider ${providerCode}`);
  }
  throw complianceBlocked(providerCode, decision.reason ?? 'blocked by compliance policy');
}

/** Convenience wrapper used by the scheduler/booking service. */
export function assertAdapterOperationAllowed(
  adapter: Pick<ProviderAdapter, 'code' | 'compliance'>,
  operation: ProviderOperation,
  context: ComplianceContext,
): void {
  assertOperationAllowed(adapter.compliance, operation, context, adapter.code);
}

/** Guard used by tests and by the seed script: never deploy a provider claiming auto-booking for a
 * provider whose payment step is human-driven on a bank page. */
export function assertComplianceConsistent(adapter: Pick<ProviderAdapter, 'code' | 'capabilities' | 'compliance'>): void {
  if (adapter.capabilities.supportsAutoBooking && adapter.capabilities.paymentsAreThirdParty) {
    throw new AppError(
      'COMPLIANCE_BLOCKED',
      `provider ${adapter.code} claims auto-booking while payments are third-party`,
      { userMessageKey: 'error.compliance_blocked', details: { providerCode: adapter.code } },
    );
  }
  if (adapter.compliance.status === 'APPROVED' && adapter.capabilities.requiresCaptcha === 'ALWAYS') {
    throw new AppError(
      'COMPLIANCE_BLOCKED',
      `provider ${adapter.code} is approved but always presents a human challenge; approval must be reviewed`,
      { userMessageKey: 'error.compliance_blocked', details: { providerCode: adapter.code } },
    );
  }
}
