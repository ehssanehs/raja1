/**
 * Egress proxy domain types.
 *
 * Posture (ADR-0008): the pool routes traffic and *respects* provider signals. A proxy that is
 * rate-limited or blocked rests; it is never swapped for a fresh IP so requesting can continue.
 * Rotation exists for even wear and admin-defined schedules, never for evasion.
 */
import type { ProxyProtocol, ProxyStatus, ProxyEventType, FailureClass } from '@raja/shared';
import type { QueryResultRow } from '@raja/database';

/** Database row shape of `proxies`. */
export interface ProxyRecord extends QueryResultRow {
  id: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username_enc: Buffer | null;
  password_enc: Buffer | null;
  provider_code: string | null;
  region: string;
  enabled: boolean;
  status: ProxyStatus;
  health_score: number;
  latency_ms: number | null;
  success_count: string | number;
  failure_count: string | number;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error_class: FailureClass | null;
  quarantined_until: Date | null;
  quarantine_count: number;
  rotation_seconds: number;
  assigned_worker_id: string | null;
  assigned_at: Date | null;
  last_rotated_at: Date | null;
  requests_per_minute: number;
  rate_budget_multiplier_pct: number;
  probe_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Row shape of `proxy_events`. `proxy_id` is NULL after the proxy itself was removed. */
export interface ProxyEventRecord extends QueryResultRow {
  id: string;
  proxy_id: string | null;
  event_type: ProxyEventType;
  source: string;
  reason: string;
  details: Record<string, unknown> | null;
  created_at: Date;
}

/** A proxy with its secrets decrypted — exists only inside a lease, never persisted or logged. */
export interface ResolvedProxy {
  id: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** A short-lived handle proving that `workerId` may send traffic through `proxyId`. */
export interface ProxyLease {
  proxyId: string;
  label: string;
  workerId: string;
  /** Requests/minute budget currently applicable (global budget × tightened multiplier). */
  requestsPerMinute: number;
  acquiredAt: Date;
}

/** Outcome of one measurement through a proxy (probe or real provider traffic). */
export interface ProxyHealthSampleInput {
  ok: boolean;
  /** Where the sample comes from: active connectivity probe or real traffic. */
  source: 'PROBE' | 'TRAFFIC';
  latencyMs?: number | null;
  /** HTTP status observed through the proxy, when applicable. */
  httpStatus?: number | null;
  /** Our failure taxonomy class, when the call failed. */
  errorClass?: FailureClass | null;
  /** True when the response content looked like a provider block/captcha page. */
  blockPage?: boolean;
  /** True when a human-verification (CAPTCHA) challenge was observed in the response. */
  captchaSeen?: boolean;
  correlationId?: string | null;
}

/** Result of the pure quarantine decision for a sample. */
export interface QuarantineDecision {
  quarantine: boolean;
  /** Rest window end, when quarantining. */
  until: Date | null;
  /** Human/ops readable reason (stable token, safe to log). */
  reason: string;
  /** Next budget multiplier (percent) to apply while resting. */
  multiplierPct: number;
}

/** Why the pool could not hand out a proxy. Stable tokens, safe to surface to admins. */
export type ProxyUnavailableReason =
  | 'POOL_DISABLED'
  | 'NO_PROXIES'
  | 'ALL_DISABLED'
  | 'ALL_QUARANTINED'
  | 'ALL_DEAD'
  | 'ALL_UNHEALTHY'
  | 'PROVIDER_MISMATCH';

/** Aggregated pool state for the admin UI. */
export interface ProxyPoolSnapshot {
  egressMode: 'OFF' | 'OPTIONAL' | 'REQUIRED';
  totals: { all: number; active: number; quarantined: number; dead: number; disabled: number };
  minHealth: number;
  proxies: ProxyProxyView[];
}

/** Admin-facing view of one proxy (no secrets, counters included). */
export interface ProxyProxyView {
  id: string;
  label: string;
  endpoint: string;
  protocol: ProxyProtocol;
  providerCode: string | null;
  region: string;
  enabled: boolean;
  status: ProxyStatus;
  healthScore: number;
  latencyMs: number | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorClass: FailureClass | null;
  quarantinedUntil: Date | null;
  quarantineCount: number;
  rotationSeconds: number;
  assignedWorkerId: string | null;
  assignedAt: Date | null;
  lastRotatedAt: Date | null;
  requestsPerMinute: number;
  rateBudgetMultiplierPct: number;
  probeAfter: Date | null;
  createdAt: Date;
  hasCredentials: boolean;
}

/** Admin create/update payload (plaintext credentials allowed on input only). */
export interface ProxyUpsertInput {
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  providerCode?: string | null;
  region?: string | null;
  rotationSeconds?: number | null;
  requestsPerMinute?: number | null;
}

export interface ProxyAdminActor {
  /** Id of the admin user performing the change (audit trail). */
  userId: string | null;
  /** Free-form origin, e.g. `web:admin`, `cli`, `system`. */
  source?: string;
}
