/**
 * Admin CRUD for the egress proxy catalogue.
 *
 * Security properties:
 *  - credentials are AES-256-GCM envelope-encrypted at rest (`username_enc`/`password_enc`)
 *  - plaintext credentials are accepted on create/update only and never returned
 *  - every mutation writes an audit row into `proxy_events` (who/what/why, no secrets)
 */
import { randomUUID } from 'node:crypto';
import { encryptString, type KeyRing } from '@raja/crypto';
import { PROXY_SETTINGS_LIMITS, conflict, notFound, validationError } from '@raja/shared';
import type { DbClient } from '@raja/database';
import type { ProxyAdminActor, ProxyEventRecord, ProxyProxyView, ProxyRecord, ProxyUpsertInput } from './types';
import type { ProxyHealthSampleView } from './retention';
import type { ProxyEventType } from '@raja/shared';

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
const MAX_PROXIES = 200;
const MAX_LABEL = 120;

function assertProxyInput(input: ProxyUpsertInput): void {
  if (!input.label || input.label.trim().length === 0) throw validationError('proxy label is required');
  if (input.label.length > MAX_LABEL) throw validationError(`proxy label must be at most ${MAX_LABEL} characters`);
  const host = input.host?.trim() ?? '';
  if (!host || (!HOST_RE.test(host) && !IPV6_RE.test(host))) throw validationError('proxy host is not a valid hostname or IP');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw validationError('proxy port must be 1..65535');
  if (input.username && input.username.length > 200) throw validationError('proxy username too long');
  if (input.password && input.password.length > 500) throw validationError('proxy password too long');
}

export interface CreateProxyResult {
  proxy: ProxyProxyView;
}

export interface ProxyServiceOptions {
  /** Injection seam for tests; defaults to crypto.randomUUID(). */
  uuid?: () => string;
}

export class ProxyAdminService {
  private readonly uuidFn: () => string;

  constructor(private readonly db: DbClient, private readonly keyRing: KeyRing, options: ProxyServiceOptions = {}) {
    this.uuidFn = options.uuid ?? randomUUID;
  }

  // ------------------------------------------------------------- admin CRUD ---

  async create(input: ProxyUpsertInput, actor: ProxyAdminActor): Promise<ProxyProxyView> {
    assertProxyInput(input);
    const count = await this.scalar('SELECT count(*)::int AS value FROM proxies');
    if (count >= MAX_PROXIES) throw conflict(`proxy catalogue is full (max ${MAX_PROXIES})`);
    const id = this.uuidFn();
    const usernameEnc = input.username ? this.encrypt(input.username) : null;
    const passwordEnc = input.password ? this.encrypt(input.password) : null;
    const rotation = this.clampRotation(input.rotationSeconds);
    const rpm = this.clampRpm(input.requestsPerMinute);
    try {
      await this.db.query(
        `INSERT INTO proxies (id, label, protocol, host, port, username_enc, password_enc, provider_code,
                              region, enabled, status, rotation_seconds, requests_per_minute)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 'ACTIVE', $10, $11)`,
        [id, input.label.trim(), input.protocol, host(input), input.port, usernameEnc, passwordEnc, input.providerCode ?? null, input.region ?? '', rotation, rpm],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('a proxy with this protocol/host/port already exists');
      throw error;
    }
    await this.record(id, 'CREATED', actor, `proxy ${input.label.trim()} added`, { rotationSeconds: rotation, requestsPerMinute: rpm });
    return (await this.get(id)) as ProxyProxyView;
  }

  async update(id: string, input: Partial<ProxyUpsertInput>, actor: ProxyAdminActor): Promise<ProxyProxyView> {
    const existing = await this.getRaw(id);
    const next: ProxyUpsertInput = {
      label: input.label ?? existing.label,
      protocol: input.protocol ?? existing.protocol,
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
    };
    assertProxyInput(next);
    const rotation = input.rotationSeconds !== undefined ? this.clampRotation(input.rotationSeconds) : existing.rotation_seconds;
    const rpm = input.requestsPerMinute !== undefined ? this.clampRpm(input.requestsPerMinute) : existing.requests_per_minute;

    // Credentials: empty string clears, undefined keeps, a value re-encrypts.
    let usernameEnc = existing.username_enc;
    let passwordEnc = existing.password_enc;
    if (input.username === null || input.username === '') usernameEnc = null;
    else if (input.username !== undefined) usernameEnc = this.encrypt(input.username);
    if (input.password === null || input.password === '') passwordEnc = null;
    else if (input.password !== undefined) passwordEnc = this.encrypt(input.password);

    await this.db.query(
      `UPDATE proxies SET label = $2, protocol = $3, host = $4, port = $5, username_enc = $6, password_enc = $7,
                          provider_code = $8, region = $9, rotation_seconds = $10, requests_per_minute = $11,
                          updated_at = now()
        WHERE id = $1`,
      [id, next.label.trim(), next.protocol, next.host, next.port, usernameEnc, passwordEnc, input.providerCode ?? existing.provider_code, input.region ?? existing.region, rotation, rpm],
    );
    await this.record(id, 'UPDATED', actor, 'proxy updated', { fields: Object.keys(input) });
    return (await this.get(id)) as ProxyProxyView;
  }

  async setEnabled(id: string, enabled: boolean, actor: ProxyAdminActor): Promise<ProxyProxyView> {
    await this.getRaw(id);
    await this.db.query('UPDATE proxies SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
    await this.record(id, enabled ? 'ENABLED' : 'DISABLED', actor, enabled ? 'proxy enabled' : 'proxy disabled');
    return (await this.get(id)) as ProxyProxyView;
  }

  async remove(id: string, actor: ProxyAdminActor): Promise<void> {
    await this.getRaw(id);
    // Audit first: the proxy row is gone after the delete, and the REMOVED event survives it
    // (FK sets proxy_id NULL; the append-only trigger refuses any direct rewrite).
    await this.record(id, 'REMOVED', actor, 'proxy removed from catalogue');
    await this.db.query('DELETE FROM proxies WHERE id = $1', [id]);
  }

  async list(options: { limit?: number; offset?: number; status?: string } = {}): Promise<{ items: ProxyProxyView[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const params: unknown[] = [limit, offset];
    let where = '';
    if (options.status) {
      params.push(options.status);
      where = `WHERE status = $${params.length}`;
    }
    const rows = await this.db.query<ProxyRecord>(
      `SELECT * FROM proxies ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const total = await this.scalar('SELECT count(*)::int AS value FROM proxies');
    return { items: rows.map(toView), total };
  }

  async get(id: string): Promise<ProxyProxyView | null> {
    const row = await this.maybeRaw(id);
    return row ? toView(row) : null;
  }

  /** Redacted events for one proxy (admin audit trail). */
  async events(proxyId: string, limit = 50): Promise<ProxyEventRecord[]> {
    const rows = await this.db.query<ProxyEventRecord>(
      'SELECT * FROM proxy_events WHERE proxy_id = $1 ORDER BY created_at DESC LIMIT $2',
      [proxyId, Math.min(limit, 200)],
    );
    return rows;
  }

  /** Recent health samples for one proxy, oldest-first (trend charts, retention-bounded). */
  async samples(proxyId: string, limit = 120): Promise<ProxyHealthSampleView[]> {
    const rows = await this.db.query<ProxyHealthSampleView>(
      'SELECT * FROM proxy_health_samples WHERE proxy_id = $1 ORDER BY created_at DESC LIMIT $2',
      [proxyId, Math.min(limit, 500)],
    );
    return rows.reverse();
  }

  // --------------------------------------------------------------- internals ---

  private async getRaw(id: string): Promise<ProxyRecord> {
    const row = await this.maybeRaw(id);
    if (!row) throw notFound('proxy', id);
    return row;
  }

  private async maybeRaw(id: string): Promise<ProxyRecord | null> {
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM proxies WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ?? null;
  }

  private encrypt(plaintext: string): Buffer {
    // The envelope is a colon-joined ASCII string; store it as bytea for schema compatibility.
    return Buffer.from(encryptString(plaintext, this.keyRing), 'utf8');
  }

  private clampRotation(seconds?: number | null): number {
    const { MIN_ROTATION_SECONDS, MAX_ROTATION_SECONDS, DEFAULT_ROTATION_SECONDS } = PROXY_SETTINGS_LIMITS;
    const value = seconds ?? DEFAULT_ROTATION_SECONDS;
    return Math.min(Math.max(Math.round(value), MIN_ROTATION_SECONDS), MAX_ROTATION_SECONDS);
  }

  private clampRpm(rpm?: number | null): number {
    const { MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE, DEFAULT_REQUESTS_PER_MINUTE } = PROXY_SETTINGS_LIMITS;
    const value = rpm ?? DEFAULT_REQUESTS_PER_MINUTE;
    return Math.min(Math.max(Math.round(value), MIN_REQUESTS_PER_MINUTE), MAX_REQUESTS_PER_MINUTE);
  }

  private async record(proxyId: string, eventType: ProxyEventType, actor: ProxyAdminActor, reason: string, details?: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO proxy_events (id, proxy_id, event_type, source, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.uuidFn(), proxyId, eventType, actor.source ?? 'admin', reason, details ? JSON.stringify(details) : null],
    );
  }

  private async scalar(sql: string): Promise<number> {
    const rows = await this.db.query<{ value: number }>(sql);
    return rows[0]?.value ?? 0;
  }
}

function host(input: ProxyUpsertInput): string {
  return input.host.trim();
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '23505';
}

/** Strip secrets and normalise a row for the admin UI. */
export function toView(row: ProxyRecord): ProxyProxyView {
  return {
    id: row.id,
    label: row.label,
    endpoint: `${row.protocol.toLowerCase()}://${row.host}:${row.port}`,
    protocol: row.protocol,
    providerCode: row.provider_code,
    region: row.region,
    enabled: row.enabled,
    status: row.status,
    healthScore: row.health_score,
    latencyMs: row.latency_ms,
    successCount: Number(row.success_count ?? 0),
    failureCount: Number(row.failure_count ?? 0),
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastErrorClass: row.last_error_class,
    quarantinedUntil: row.quarantined_until,
    quarantineCount: row.quarantine_count,
    rotationSeconds: row.rotation_seconds,
    assignedWorkerId: row.assigned_worker_id,
    assignedAt: row.assigned_at,
    lastRotatedAt: row.last_rotated_at,
    requestsPerMinute: row.requests_per_minute,
    rateBudgetMultiplierPct: row.rate_budget_multiplier_pct,
    probeAfter: row.probe_after,
    createdAt: row.created_at,
    hasCredentials: row.username_enc !== null || row.password_enc !== null,
  };
}
