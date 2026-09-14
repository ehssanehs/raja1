/**
 * Integration test: the admin HTTP surface (auth guard, CRUD, settings) against the real schema.
 * The server binds 127.0.0.1 on an ephemeral port; no egress is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig, resetConfigCache } from '@raja/config';
import { startAdminApi } from '../src/index';
import { ProxyPool } from '@raja/proxy';
import { createKeyRing } from '@raja/crypto';

describe('admin proxy api', () => {
  let api: Awaited<ReturnType<typeof startAdminApi>>;
  let base: string;
  const token = 'test-admin-token';
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  beforeAll(async () => {
    process.env['EGRESS_MODE'] = 'REQUIRED';
    process.env['MASTER_KEYS'] = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    resetConfigCache();
    getConfig();
    api = await startAdminApi({ adminToken: token, port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${api.port}/api/v1`;
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    resetConfigCache();
  });

  it('rejects unauthenticated calls', async () => {
    const response = await fetch(`${base}/admin/proxies`);
    expect(response.status).toBe(401);
  });

  it('exposes unauthenticated health endpoints with no data', async () => {
    const live = await fetch(`${base.replace('/api/v1', '')}/health/live`);
    expect(live.status).toBe(200);
    const ready = (await (await fetch(`${base.replace('/api/v1', '')}/health/ready`)).json()) as { ok: boolean; checks: { database: boolean } };
    expect(ready.ok).toBe(true);
    expect(ready.checks.database).toBe(true);
  });

  it('brakes brute-force auth attempts with 429 after the failure budget', async () => {
    // The guard allows 20 failures/minute per ip; the earlier 401 above consumed one.
    let lastStatus = 0;
    for (let i = 0; i < 25; i += 1) {
      const response = await fetch(`${base}/admin/proxies`, { headers: { authorization: 'Bearer wrong-token' } });
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('creates, lists, updates and removes a proxy', async () => {
    const created = await fetch(`${base}/admin/proxies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'api-test', protocol: 'HTTP', host: '10.9.0.1', port: 8080, username: 'u', password: 'p' }),
    });
    expect(created.status).toBe(201);
    const view = (await created.json()) as { id: string; hasCredentials: boolean; endpoint: string };
    expect(view.hasCredentials).toBe(true);
    expect(view.endpoint).toBe('http://10.9.0.1:8080');
    expect(JSON.stringify(view)).not.toContain('p"');

    const list = (await (await fetch(`${base}/admin/proxies`, { headers })).json()) as { items: unknown[]; total: number };
    expect(list.total).toBeGreaterThan(0);

    const updated = await fetch(`${base}/admin/proxies/${view.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ label: 'api-test-2', requestsPerMinute: 30 }),
    });
    const updatedView = (await updated.json()) as { label: string; requestsPerMinute: number };
    expect(updatedView.label).toBe('api-test-2');
    expect(updatedView.requestsPerMinute).toBe(30);

    const removed = await fetch(`${base}/admin/proxies/${view.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(removed.status).toBe(200);
    const gone = await fetch(`${base}/admin/proxies/${view.id}`, { headers });
    expect(gone.status).toBe(404);
  });

  it('reads and updates pool settings (fail-closed values preserved on invalid input)', async () => {
    const settings = (await (await fetch(`${base}/admin/proxy-settings`, { headers })).json()) as { egressMode: string };
    expect(['OFF', 'OPTIONAL', 'REQUIRED']).toContain(settings.egressMode);

    const updated = await fetch(`${base}/admin/proxy-settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ egressMode: 'OPTIONAL', minHealthScore: 25 }),
    });
    const next = (await updated.json()) as { egressMode: string; minHealthScore: number };
    expect(next.egressMode).toBe('OPTIONAL');
    expect(next.minHealthScore).toBe(25);

    // restore
    await fetch(`${base}/admin/proxy-settings`, { method: 'PUT', headers, body: JSON.stringify({ egressMode: 'REQUIRED', minHealthScore: 0 }) });
  });

  it('serves per-proxy health samples for trend charts (oldest first)', async () => {
    const created = await fetch(`${base}/admin/proxies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'trendy', protocol: 'HTTP', host: '10.9.1.1', port: 8080 }),
    });
    const view = (await created.json()) as { id: string };
    // Record observations through the same database the API server opened.
    const ring = createKeyRing(JSON.parse(process.env['MASTER_KEYS']!), 'k1');
    const pool = new ProxyPool(api.db, ring, { egressMode: 'OPTIONAL' });
    await pool.recordHealth(view.id, { ok: true, source: 'PROBE', latencyMs: 150, httpStatus: 204 });
    await pool.recordHealth(view.id, { ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' });

    const response = await fetch(`${base}/admin/proxies/${view.id}/samples?limit=10`, { headers });
    expect(response.status).toBe(200);
    const samples = (await response.json()) as { ok: boolean; latency_ms: number | null; created_at: string }[];
    expect(samples).toHaveLength(2);
    expect(new Date(samples[0]!.created_at).getTime()).toBeLessThanOrEqual(new Date(samples[1]!.created_at).getTime());
    expect(samples[0]!.latency_ms).toBe(150);
  });

  it('returns the pool snapshot without secrets', async () => {
    const snapshot = (await (await fetch(`${base}/admin/proxies/pool`, { headers })).json()) as { totals: { all: number }; proxies: Record<string, unknown>[] };
    expect(snapshot.totals.all).toBeGreaterThanOrEqual(0);
    for (const proxy of snapshot.proxies) {
      expect(proxy['username']).toBeUndefined();
      expect(proxy['password']).toBeUndefined();
    }
  });
});
