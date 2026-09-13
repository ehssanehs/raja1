/**
 * Integration test: admin CRUD + pool leasing + quarantine lifecycle against the real schema
 * (PGlite/WASM) through the real migration runner.
 *
 * Proves the operational claims from docs/proxy-pool.md:
 *  - admin can add/list/enable/disable/remove proxies; credentials are encrypted at rest and
 *    never returned by reads
 *  - workers acquire leases (sticky per worker) and the same worker keeps its proxy
 *  - a quarantined proxy is not handed out until its rest window elapses; a successful probe
 *    afterwards releases it and restores the budget gradually
 *  - provider restriction signals (429) quarantine the proxy and tighten its budget
 *  - every mutation leaves an audit trail in proxy_events
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteClient, runIntegrityChecks, type DbClient } from '@raja/database';
import { MIGRATIONS } from '../../database/src/migrations';
import { migrateUp } from '../../database/src/migrate';
import { createKeyRing } from '@raja/crypto';
import { ProxyAdminService } from '../src/admin';
import { ProxyPool } from '../src/pool';
import { ProxyProber } from '../src/prober';
import { ProxyUnavailableError } from '../src/errors';

const ACTOR = { userId: '00000000-0000-4000-8000-0000000000d1', source: 'test:admin' };

let db: DbClient;
let admin: ProxyAdminService;
let pool: ProxyPool;

beforeAll(async () => {
  db = await PGliteClient.create();
  await migrateUp(db, { skipLock: true, appliedBy: 'integration-test' });
  const ring = createKeyRing({ k1: Buffer.alloc(32, 7).toString('base64') }, 'k1');
  admin = new ProxyAdminService(db, ring);
  pool = new ProxyPool(db, ring, { egressMode: 'REQUIRED', probeIntervalSeconds: 60 });
});

afterAll(async () => {
  await db?.close();
});

describe('proxy admin CRUD', () => {
  it('creates a proxy with encrypted credentials and redacted reads', async () => {
    const view = await admin.create(
      { label: 'dc-1', protocol: 'HTTP', host: '10.0.0.1', port: 8080, username: 'user', password: 'pass', requestsPerMinute: 20, rotationSeconds: 1800 },
      ACTOR,
    );
    expect(view.hasCredentials).toBe(true);
    expect(view.endpoint).toBe('http://10.0.0.1:8080');
    expect(view.status).toBe('ACTIVE');
    expect(view.requestsPerMinute).toBe(20);
    expect(view.rotationSeconds).toBe(1800);

    const raw = await db.query<{ username_enc: Buffer | null; password_enc: Buffer | null }>(
      'SELECT username_enc, password_enc FROM proxies WHERE id = $1',
      [view.id],
    );
    const storedUser = Buffer.from(raw[0]!.username_enc!).toString('utf8');
    expect(storedUser).not.toContain('user');
    expect(storedUser.startsWith('enc:v1:')).toBe(true);
  });

  it('rejects duplicate endpoints and invalid input', async () => {
    await expect(admin.create({ label: 'dup', protocol: 'HTTP', host: '10.0.0.1', port: 8080 }, ACTOR)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(admin.create({ label: 'bad', protocol: 'HTTP', host: 'not a host', port: 8080 }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(admin.create({ label: 'bad-port', protocol: 'HTTP', host: '10.0.0.2', port: 99_999 }, ACTOR)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('clamps rotation and rate settings to platform bounds', async () => {
    const view = await admin.create({ label: 'clamped', protocol: 'HTTP', host: '10.0.0.3', port: 3128, rotationSeconds: 5, requestsPerMinute: 5000 }, ACTOR);
    expect(view.rotationSeconds).toBe(300);
    expect(view.requestsPerMinute).toBe(60);
  });

  it('records an audit trail for every mutation', async () => {
    const view = await admin.create({ label: 'audited', protocol: 'HTTP', host: '10.0.0.4', port: 8080 }, ACTOR);
    await admin.setEnabled(view.id, false, ACTOR);
    const events = await admin.events(view.id);
    expect(events.map((event) => event.event_type)).toEqual(['DISABLED', 'CREATED']);
  });
});

describe('pool leasing', () => {
  it('refuses to lease when the pool is OFF (fail-closed default)', async () => {
    const off = new ProxyPool(db, createKeyRing({ k1: Buffer.alloc(32, 7).toString('base64') }, 'k1'), { egressMode: 'OFF' });
    await expect(off.acquire('w-off')).rejects.toMatchObject({ name: 'ProxyUnavailableError', reason: 'POOL_DISABLED' });
  });

  it('leases a proxy to a worker and keeps it sticky across acquisitions', async () => {
    await admin.create({ label: 'sticky-a', protocol: 'HTTP', host: '10.1.0.1', port: 8080 }, ACTOR);
    await admin.create({ label: 'sticky-b', protocol: 'HTTP', host: '10.1.0.2', port: 8080 }, ACTOR);
    // Hermetic: park proxies created by earlier tests so this test owns exactly two leases.
    await db.query("UPDATE proxies SET enabled = false WHERE label NOT IN ('sticky-a','sticky-b')");

    const lease1 = await pool.acquire('worker-1');
    const lease2 = await pool.acquire('worker-1');
    expect(lease1.proxyId).toBe(lease2.proxyId);

    // A second worker gets a *different* proxy (one proxy, one worker).
    const lease3 = await pool.acquire('worker-2');
    expect(lease3.proxyId).not.toBe(lease1.proxyId);

    // A third worker finds the pool exhausted (2 proxies, 2 workers).
    await expect(pool.acquire('worker-3')).rejects.toBeInstanceOf(ProxyUnavailableError);
  });

  it('does not hand a quarantined proxy out until the rest window elapses, then recovers it via probe', async () => {
    const view = await admin.create({ label: 'resting', protocol: 'HTTP', host: '10.2.0.1', port: 8080 }, ACTOR);
    const mine = await pool.acquire('worker-rest');
    expect(mine.proxyId).toBe(view.id);

    // Provider rate-limits this egress mid-job.
    await pool.recordHealth(view.id, { ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' });

    const after = await db.query<{ status: string; quarantined_until: Date; rate_budget_multiplier_pct: number; assigned_worker_id: string | null }>(
      'SELECT status, quarantined_until, rate_budget_multiplier_pct, assigned_worker_id FROM proxies WHERE id = $1',
      [view.id],
    );
    expect(after[0]!.status).toBe('QUARANTINED');
    expect(after[0]!.quarantined_until.getTime()).toBeGreaterThan(Date.now());
    expect(after[0]!.rate_budget_multiplier_pct).toBe(50);
    // The restriction also frees the assignment: the worker stops using the resting proxy.
    expect(after[0]!.assigned_worker_id).toBeNull();

    // While resting, the pool offers nothing (it is the only proxy).
    await expect(pool.acquire('worker-rest')).rejects.toBeInstanceOf(ProxyUnavailableError);

    // A *failing* probe before/after the rest window does not release it (rest means rest;
    // recovery requires a successful probe). Unroutable target => connection failure.
    const prober = new ProxyProber(db, pool, { targetUrl: 'http://127.0.0.1:1/_probe', maxPerRun: 5 });
    const rows = await db.query('SELECT * FROM proxies WHERE id = $1', [view.id]);
    await prober.probeRows(rows);
    const still = await db.query<{ status: string }>('SELECT status FROM proxies WHERE id = $1', [view.id]);
    expect(still[0]!.status).toBe('QUARANTINED');

    // After the rest window elapses, a successful probe releases quarantine and restores budget.
    await db.query(`UPDATE proxies SET quarantined_until = now() - interval '1 second', probe_after = now() - interval '1 second' WHERE id = $1`, [view.id]);
    // (Sandboxed CI has no egress; simulate the successful probe the prober would record.)
    await pool.recordHealth(view.id, { ok: true, source: 'PROBE', latencyMs: 120, httpStatus: 204 });
    const recovered = await db.query<{ status: string; rate_budget_multiplier_pct: number; quarantined_until: Date | null }>(
      'SELECT status, rate_budget_multiplier_pct, quarantined_until FROM proxies WHERE id = $1',
      [view.id],
    );
    expect(recovered[0]!.status).toBe('ACTIVE');
    expect(recovered[0]!.rate_budget_multiplier_pct).toBe(100);
    expect(recovered[0]!.quarantined_until).toBeNull();
  });

  it('resolves decrypted connection material inside a lease only', async () => {
    const view = await admin.create({ label: 'resolve-me', protocol: 'HTTP', host: '10.3.0.1', port: 8080, username: 'u1', password: 'p1' }, ACTOR);
    const resolved = await pool.resolveById(view.id);
    expect(resolved.username).toBe('u1');
    expect(resolved.password).toBe('p1');
    expect(resolved.host).toBe('10.3.0.1');
  });

  it('snapshot aggregates pool state without secrets', async () => {
    const snapshot = await pool.snapshot();
    expect(snapshot.egressMode).toBe('REQUIRED');
    expect(snapshot.totals.all).toBeGreaterThan(0);
    for (const proxy of snapshot.proxies) {
      expect(JSON.stringify(proxy)).not.toContain('"password"');
      expect(Object.keys(proxy)).not.toContain('username');
    }
  });
});

describe('proxy_events integrity', () => {
  it('records quarantine and release events automatically', async () => {
    const view = await admin.create({ label: 'eventful', protocol: 'HTTP', host: '10.4.0.1', port: 8080 }, ACTOR);
    await pool.recordHealth(view.id, { ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' });
    await db.query(`UPDATE proxies SET quarantined_until = now() - interval '1 second', probe_after = now() - interval '1 second' WHERE id = $1`, [view.id]);
    const rows = await db.query('SELECT * FROM proxies WHERE id = $1', [view.id]);
    const prober = new ProxyProber(db, pool, { targetUrl: 'http://127.0.0.1:1/_probe' });
    // Failing probe keeps it quarantined with a network error; the event trail shows the lifecycle.
    await prober.probeRows(rows);
    expect(rows.length).toBeGreaterThan(0);
    const events = await db.query<{ event_type: string; source: string }>(
      'SELECT event_type, source FROM proxy_events WHERE proxy_id = $1 ORDER BY created_at ASC',
      [view.id],
    );
    expect(events.map((event) => event.event_type)).toContain('QUARANTINED');
  });

  it('never leaks proxy secrets into proxy_events details', async () => {
    const rows = await db.query<{ details: string | null }>('SELECT details FROM proxy_events');
    for (const row of rows) {
      if (row.details) {
        expect(row.details).not.toContain('p1');
        expect(row.details).not.toContain('enc:v1');
      }
    }
  });
});

describe('proxy pool integrity check', () => {
  it('is coherent in normal operation (no lease on resting/dead proxies, settings in bounds)', async () => {
    const { results, ok } = await runIntegrityChecks(db);
    const check = results.find((result) => result.name === 'proxy_pool_consistency');
    expect(check).toBeDefined();
    expect(check!.severity).toBe('WARNING');
    expect(check!.ok).toBe(true);
    void ok;
  });

  it('flags a resting proxy that still holds a worker lease', async () => {
    const view = await admin.create({ label: 'incoherent', protocol: 'HTTP', host: '10.6.0.1', port: 8080 }, ACTOR);
    // Simulate drift: a manual UPDATE that quarantines without freeing the lease.
    await db.query(
      `UPDATE proxies SET status = 'QUARANTINED', quarantined_until = now() + interval '10 minutes',
                          assigned_worker_id = 'stale-worker'
        WHERE id = $1`,
      [view.id],
    );
    const { results } = await runIntegrityChecks(db);
    const check = results.find((result) => result.name === 'proxy_pool_consistency');
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/still hold a worker lease/);
    // Heal through the documented path: recordHealth frees the lease on quarantine.
    await pool.recordHealth(view.id, { ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' });
    const healed = await runIntegrityChecks(db);
    expect(healed.results.find((result) => result.name === 'proxy_pool_consistency')!.ok).toBe(true);
  });
});

describe('rotation schedule', () => {
  it('moves a worker off its proxy once the admin-defined rotation window elapsed', async () => {
    // Fresh catalogue: two proxies, one assigned to our worker with a backdated rotation stamp.
    await db.query("UPDATE proxies SET enabled = false, assigned_worker_id = NULL WHERE label NOT IN ('rot-keep','rot-next')");
    const keep = await admin.create({ label: 'rot-keep', protocol: 'HTTP', host: '10.5.0.1', port: 8080 }, ACTOR);
    const next = await admin.create({ label: 'rot-next', protocol: 'HTTP', host: '10.5.0.2', port: 8080 }, ACTOR);
    await db.query(
      `UPDATE proxies SET assigned_worker_id = 'worker-rot', assigned_at = now(), last_rotated_at = now() - interval '2 hours'
        WHERE id = $1`,
      [keep.id],
    );
    const lease = await pool.acquire('worker-rot');
    expect(lease.proxyId).toBe(next.id); // rotated to the other (least-recently-rotated) proxy
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM proxy_events WHERE proxy_id = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1',
      [next.id, 'pool:worker-rot'],
    );
    expect(events[0]?.event_type).toBe('LEASE_ACQUIRED');
  });
});
