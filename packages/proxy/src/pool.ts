/**
 * The egress pool: leases a proxy to a worker for a *course of requests*, records health,
 * rotates on admin-defined schedules and quarantines on provider restriction signals.
 *
 * Fail-closed semantics:
 *  - `egressMode=OFF`       → the pool never hands out anything; callers use direct egress.
 *  - `egressMode=REQUIRED`  → no lease ⇒ the caller must NOT send provider traffic at all.
 *  - credentials live only inside a `ResolvedProxy` held by the lease; leases auto-expire.
 */
import { decryptString, type KeyRing } from '@raja/crypto';
import type { DbClient } from '@raja/database';
import { PROXY_SETTINGS_LIMITS, type EgressMode, type ProxyEventType } from '@raja/shared';
import { ProxyUnavailableError, ProxyProtocolUnsupportedError } from './errors';
import { selectProxy, type SelectableProxy } from './rotation';
import type { ProxyHealthSampleInput, ProxyLease, ProxyRecord, ResolvedProxy } from './types';
import { decideQuarantine, nextHealthScore, shouldMarkDead } from './quarantine';
import { toView } from './admin';
import type { ProxyPoolSnapshot, ProxyProxyView } from './types';

export interface PoolSettings {
  egressMode: EgressMode;
  minHealthScore: number;
  /** Probe interval for quarantined/dead-adjacent proxies (seconds). */
  probeIntervalSeconds: number;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  egressMode: 'OFF',
  minHealthScore: 0,
  probeIntervalSeconds: 300,
};

export interface LeaseOptions {
  /** Provider the traffic is destined to (affinity + quarantine scoping). */
  providerCode?: string | null;
  /** Requested lease duration (ms); bounded below by 30s and above by 30min. */
  ttlMs?: number;
}

const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 30 * 60_000;

export class ProxyPool {
  private settings: PoolSettings;

  constructor(private readonly db: DbClient, private readonly keyRing: KeyRing, settings?: Partial<PoolSettings>) {
    this.settings = { ...DEFAULT_POOL_SETTINGS, ...settings };
  }

  getSettings(): PoolSettings {
    return this.settings;
  }

  updateSettings(patch: Partial<PoolSettings>): PoolSettings {
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }

  /**
   * Acquire a lease on a proxy for this worker. Throws `ProxyUnavailableError` when the pool
   * cannot serve (mode OFF/REQUIRED with empty pool). `OPTIONAL` mode with an empty/resting pool
   * also throws — the *caller* decides to fall back to direct egress; the pool never silently
   * mixes routing behind the caller's back.
   */
  async acquire(workerId: string, options: LeaseOptions = {}): Promise<ProxyLease> {
    const mode = this.settings.egressMode;
    if (mode === 'OFF') throw new ProxyUnavailableError('POOL_DISABLED');
    const now = new Date();
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM proxies ORDER BY health_score DESC, last_rotated_at ASC NULLS FIRST');
    const selectable: SelectableProxy[] = rows.map(toSelectable);
    const outcome = selectProxy({
      proxies: selectable,
      now,
      egressMode: mode,
      providerCode: options.providerCode ?? null,
      workerId,
      minHealthScore: this.settings.minHealthScore,
    });
    if (!outcome.selected) {
      throw new ProxyUnavailableError(outcome.unavailableReason ?? 'ALL_UNHEALTHY');
    }
    const chosen = outcome.selected;
    const ttl = Math.min(Math.max(options.ttlMs ?? 10 * 60_000, MIN_LEASE_MS), MAX_LEASE_MS);
    const expiresAt = new Date(now.getTime() + ttl);

    // Single transaction: free this worker's previous assignment (rotation moves the worker),
    // then claim the chosen proxy. The claim survives only if no other live lease holds the row
    // (or the lease is ours). Expired assignments (lease LOST) are reclaimable.
    const claimed = await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE proxies SET assigned_worker_id = NULL, assigned_at = NULL, updated_at = now() WHERE assigned_worker_id = $1 AND id <> $2',
        [workerId, chosen.id],
      );
      return tx.query<{ id: string }>(
        `UPDATE proxies SET assigned_worker_id = $2, assigned_at = $3, last_rotated_at = $4, updated_at = now()
          WHERE id = $1
            AND enabled
            AND status = 'ACTIVE'
            AND (quarantined_until IS NULL OR quarantined_until <= $5)
            AND health_score >= $6
            AND (assigned_worker_id IS NULL OR assigned_worker_id = $2 OR assigned_at IS NULL OR assigned_at < $7)
          RETURNING id`,
        // An assignment held by ANOTHER worker is only stealable once it is older than the max
        // lease (crashed worker): $7 = max lease horizon. Fresh leases of live workers are safe.
        [chosen.id, workerId, now, outcome.rotated || !outcome.sticky ? now : chosen.lastRotatedAt ?? now, now, this.settings.minHealthScore, new Date(now.getTime() - MAX_LEASE_MS)],
      );
    });
    if (claimed.length === 0) {
      // Lost a race (another worker claimed it, or it just got quarantined/disabled).
      throw new ProxyUnavailableError('ALL_UNHEALTHY', 'proxy claim lost a concurrent assignment race');
    }
    await this.insertEvent(chosen.id, 'LEASE_ACQUIRED', `pool:${workerId}`, outcome.reason, { sticky: outcome.sticky, rotated: outcome.rotated });
    return {
      proxyId: chosen.id,
      label: chosen.label,
      workerId,
      requestsPerMinute: this.effectiveRpm(rows.find((row) => row.id === chosen.id)),
      acquiredAt: now,
    };
  }

  /** Release a lease early (worker idle/shutdown). Rotation timestamps stay untouched. */
  async release(workerId: string, proxyId: string): Promise<void> {
    await this.db.query(
      `UPDATE proxies SET assigned_worker_id = NULL, assigned_at = NULL, updated_at = now()
        WHERE id = $1 AND assigned_worker_id = $2`,
      [proxyId, workerId],
    );
    await this.insertEvent(proxyId, 'LEASE_RELEASED', `pool:${workerId}`, 'lease released');
  }

  /**
   * Decrypt the connection material for an active lease. The result must stay in memory for the
   * duration of the requests and must never be logged (the redactor catches common key names).
   */
  resolve(lease: ProxyLease): Promise<ResolvedProxy> {
    return this.resolveById(lease.proxyId);
  }

  async resolveById(proxyId: string): Promise<ResolvedProxy> {
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM proxies WHERE id = $1 LIMIT 1', [proxyId]);
    const row = rows[0];
    if (!row) throw new ProxyUnavailableError('NO_PROXIES', `proxy ${proxyId} vanished from the catalogue`);
    if (!row.enabled || row.status === 'DEAD') throw new ProxyUnavailableError('ALL_DISABLED', `proxy ${proxyId} is not usable`);
    const username = row.username_enc ? decryptString(Buffer.from(row.username_enc).toString('utf8'), this.keyRing) : null;
    const password = row.password_enc ? decryptString(Buffer.from(row.password_enc).toString('utf8'), this.keyRing) : null;
    if (row.protocol === 'SOCKS5') throw new ProxyProtocolUnsupportedError(row.protocol);
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      username,
      password,
    };
  }

  /**
   * Record one health observation and apply the quarantine decision.
   * Used by both the prober and real provider traffic paths.
   */
  async recordHealth(proxyId: string, sample: ProxyHealthSampleInput): Promise<void> {
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM proxies WHERE id = $1 LIMIT 1', [proxyId]);
    const row = rows[0];
    if (!row) return;
    const now = new Date();
    const consecutiveFailures = sample.ok ? 0 : row.consecutive_failures + 1;

    // While quarantined, only *probe* samples are recorded (traffic should not exist).
    const quarantined = row.quarantined_until !== null && row.quarantined_until.getTime() > now.getTime();

    let decision = decideQuarantine(sample, {
      consecutiveFailures,
      currentMultiplierPct: row.rate_budget_multiplier_pct,
      quarantineCount: row.quarantine_count,
      restSeconds: null,
    }, now);
    if (quarantined && sample.source === 'PROBE' && sample.ok) {
      // A successful probe after the rest window elapses is what ends quarantine; see probeDue().
      decision = { quarantine: false, until: null, reason: 'PROBE_OK_DURING_REST', multiplierPct: row.rate_budget_multiplier_pct };
    }

    const quarantineCount = decision.quarantine ? row.quarantine_count + 1 : row.quarantine_count;
    const multiplierPct = decision.quarantine ? decision.multiplierPct : sample.ok ? Math.min(100, row.rate_budget_multiplier_pct * 2) : row.rate_budget_multiplier_pct;
    const markDead = !quarantined && shouldMarkDead(consecutiveFailures, sample);

    await this.db.query(
      `UPDATE proxies SET
          health_score = $2,
          latency_ms = $3,
          success_count = success_count + $4,
          failure_count = failure_count + $5,
          consecutive_failures = $6,
          last_success_at = CASE WHEN $4::int > 0 THEN $7 ELSE last_success_at END,
          last_failure_at = CASE WHEN $5::int > 0 THEN $7 ELSE last_failure_at END,
          last_error_class = $8,
          status = $9,
          quarantined_until = $10,
          quarantine_count = $11,
          rate_budget_multiplier_pct = $12,
          probe_after = $13,
          assigned_worker_id = CASE WHEN $14::boolean THEN NULL ELSE assigned_worker_id END,
          assigned_at = CASE WHEN $14::boolean THEN NULL ELSE assigned_at END,
          updated_at = now()
        WHERE id = $1`,
      [
        proxyId,
        nextHealthScore(row.health_score, sample),
        sample.latencyMs ?? row.latency_ms,
        sample.ok ? 1 : 0,
        sample.ok ? 0 : 1,
        consecutiveFailures,
        now,
        sample.errorClass ?? null,
        markDead ? 'DEAD' : decision.quarantine ? 'QUARANTINED' : row.status === 'QUARANTINED' && !decision.quarantine && sample.ok && sample.source === 'PROBE' ? 'ACTIVE' : row.status,
        decision.quarantine ? decision.until : sample.ok && sample.source === 'PROBE' ? null : row.quarantined_until,
        quarantineCount,
        multiplierPct,
        this.nextProbeAfter(row, decision, now),
        decision.quarantine, // a resting proxy serves nobody: free its lease immediately
      ],
    );
    if (decision.quarantine) {
      await this.insertEvent(proxyId, 'QUARANTINED', sample.source.toLowerCase(), decision.reason, { httpStatus: sample.httpStatus ?? null, errorClass: sample.errorClass ?? null });
    } else if (markDead) {
      await this.insertEvent(proxyId, 'MARKED_DEAD', sample.source.toLowerCase(), 'sustained hard failures', { consecutiveFailures });
    } else if (sample.ok && sample.source === 'PROBE' && row.status === 'QUARANTINED') {
      await this.insertEvent(proxyId, 'QUARANTINE_RELEASED', 'probe', 'successful probe after rest window');
    } else if (sample.ok && sample.source === 'PROBE' && row.status === 'DEAD') {
      await this.insertEvent(proxyId, 'RECOVERED', 'probe', 'successful probe on dead proxy');
    }
  }

  /** Whether a quarantined proxy is due for a recovery probe (respecting the rest window). */
  probeDue(proxy: Pick<ProxyRecord, 'status' | 'quarantined_until' | 'probe_after'>, now = new Date()): boolean {
    if (proxy.status === 'ACTIVE' && (proxy.quarantined_until === null || proxy.quarantined_until.getTime() <= now.getTime())) return false;
    if (proxy.probe_after !== null && proxy.probe_after.getTime() > now.getTime()) return false;
    // Never probe before the quarantine window itself has elapsed — rest means rest.
    if (proxy.quarantined_until !== null && proxy.quarantined_until.getTime() > now.getTime()) return false;
    return true;
  }

  /** The per-proxy request budget actually applicable right now (rest multiplier applied). */
  effectiveRpm(row?: ProxyRecord): number {
    if (!row) return PROXY_SETTINGS_LIMITS.DEFAULT_REQUESTS_PER_MINUTE;
    return Math.max(1, Math.round((row.requests_per_minute * row.rate_budget_multiplier_pct) / 100));
  }

  /** Admin dashboard snapshot (no secrets). */
  async snapshot(): Promise<ProxyPoolSnapshot> {
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM proxies ORDER BY created_at DESC');
    const views = rows.map(toView);
    return {
      egressMode: this.settings.egressMode,
      totals: {
        all: views.length,
        active: views.filter((view) => view.enabled && view.status === 'ACTIVE' && (view.quarantinedUntil === null || view.quarantinedUntil.getTime() <= Date.now())).length,
        quarantined: views.filter((view) => view.status === 'QUARANTINED' || (view.quarantinedUntil !== null && view.quarantinedUntil.getTime() > Date.now())).length,
        dead: views.filter((view) => view.status === 'DEAD').length,
        disabled: views.filter((view) => !view.enabled).length,
      },
      minHealth: this.settings.minHealthScore,
      proxies: views,
    };
  }

  private nextProbeAfter(row: ProxyRecord, decision: { quarantine: boolean }, now: Date): Date {
    const interval = this.settings.probeIntervalSeconds * 1000;
    if (decision.quarantine) {
      // First possible recovery check happens after the rest window, then at probe intervals.
      const rest = row.quarantined_until?.getTime();
      return new Date((rest && rest > now.getTime() ? rest : now.getTime()) + interval);
    }
    return new Date(now.getTime() + interval);
  }

  private async insertEvent(proxyId: string, eventType: ProxyEventType, source: string, reason: string, details?: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO proxy_events (id, proxy_id, event_type, source, reason, details)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [proxyId, eventType, source, reason, details ? JSON.stringify(details) : null],
    );
  }
}

function toSelectable(row: ProxyRecord): SelectableProxy {
  return {
    id: row.id,
    label: row.label,
    providerCode: row.provider_code,
    enabled: row.enabled,
    status: row.status,
    healthScore: row.health_score,
    quarantinedUntil: row.quarantined_until,
    rotationSeconds: row.rotation_seconds,
    assignedWorkerId: row.assigned_worker_id,
    lastRotatedAt: row.last_rotated_at,
  };
}
