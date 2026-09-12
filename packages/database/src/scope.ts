/**
 * Tenant scoping primitives (TM-01).
 *
 * Every repository method requires a scope object. A missing scope is a **compile-time** error;
 * a query that reaches the driver without a tenant predicate is a **runtime** error
 * (`assertScopedSql`), and any tenant-scope violation raises an alertable error code.
 */
import { tenantScopeViolation } from '@raja/shared';

export interface TenantScope {
  readonly tenantId: string;
  /** Actor performing the operation (user id) — used for audit and permission re-checks. */
  readonly actorId?: string;
  /** True when the actor is platform staff acting cross-tenant (requires an explicit permission). */
  readonly isPlatformStaff?: boolean;
}

export interface PlatformScope {
  readonly platform: true;
  readonly actorId: string;
  /** Justification recorded in the audit event when platform staff touch tenant data. */
  readonly justification?: string;
}

export type Scope = TenantScope | PlatformScope;

export function tenantScope(tenantId: string, actorId?: string): TenantScope {
  if (!tenantId) throw tenantScopeViolation({ reason: 'empty tenant id' });
  return Object.freeze({ tenantId, ...(actorId ? { actorId } : {}) });
}

export function platformScope(actorId: string, justification?: string): PlatformScope {
  if (!actorId) throw tenantScopeViolation({ reason: 'empty actor id' });
  return Object.freeze({ platform: true as const, actorId, ...(justification ? { justification } : {}) });
}

export function isTenantScope(scope: Scope): scope is TenantScope {
  return !('platform' in scope) || scope.platform !== true;
}

/** Tables that carry `tenant_id` and therefore must always be filtered by it. */
export const TENANT_SCOPED_TABLES = [
  'users',
  'sessions',
  'user_settings',
  'notification_preferences',
  'telegram_links',
  'telegram_link_challenges',
  'passengers',
  'consent_records',
  'provider_accounts',
  'provider_sessions',
  'provider_account_assignments',
  'booking_requests',
  'booking_passengers',
  'booking_monitors',
  'booking_attempts',
  'booking_results',
  'booking_timeline_events',
  'booking_transitions',
  'reservations',
  'search_jobs',
  'wallets',
  'wallet_transactions',
  'credits',
  'charge_authorizations',
  'invoices',
  'payments',
  'subscriptions',
  'quota_counters',
  'coupon_redemptions',
  'referral_codes',
  'referrals',
  'notifications',
  'release_window_admissions',
  'support_tickets',
  'support_messages',
  'fraud_signals',
  'diagnostics_artifacts',
  'job_deadlines',
] as const;

const TENANT_PREDICATE_RE = /\btenant_id\s*(?:<>|!=|=|\bIN\b|\bANY\b|\bIS NOT NULL\b)/i;

/**
 * Runtime guard: refuses to execute a statement against a tenant-scoped table without a tenant
 * predicate. This is defense in depth behind the typed repositories: it catches raw SQL.
 */
export function assertScopedSql(sql: string, params: readonly unknown[] = []): void {
  const lowered = sql.toLowerCase();
  for (const table of TENANT_SCOPED_TABLES) {
    const referencesTable = new RegExp(`\\b(from|join|into|update)\\s+"?${table}"?\\b`).test(lowered);
    if (!referencesTable) continue;
    const scoped = TENANT_PREDICATE_RE.test(sql);
    const hasParam = params.some((param) => typeof param === 'string' && param.length >= 8);
    if (!scoped) {
      throw tenantScopeViolation({
        table,
        reason: 'statement references a tenant-scoped table without a tenant_id predicate',
        sqlPreview: sql.slice(0, 160),
        hasParam,
      });
    }
  }
}

/** Build a `tenant_id = $n` fragment while tracking parameter positions. */
export class SqlBuilder {
  private readonly params: unknown[] = [];

  constructor(private readonly scope: Scope) {}

  /** Push a parameter and return its placeholder. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** Tenant predicate placeholder (throws for platform scope — callers must opt in explicitly). */
  tenantPredicate(column = 'tenant_id'): string {
    if (!isTenantScope(this.scope)) {
      throw tenantScopeViolation({ reason: 'tenantPredicate() called with a platform scope' });
    }
    return `${column} = ${this.param(this.scope.tenantId)}`;
  }

  get values(): readonly unknown[] {
    return this.params;
  }

  get nextIndex(): number {
    return this.params.length + 1;
  }
}
