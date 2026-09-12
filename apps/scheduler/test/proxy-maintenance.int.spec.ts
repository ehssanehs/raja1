/**
 * Integration test: scheduler proxy maintenance — probing the due set and raising
 * degraded/exhausted notifications — against the real schema (PGlite).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConfig, resetConfigCache } from '@raja/config';
import { PGliteClient, migrateUp, type DbClient } from '@raja/database';
import { createKeyRing } from '@raja/crypto';
import { ProxyAdminService, ProxyPool } from '@raja/proxy';
import { runProxyMaintenance } from '../src/index';

const ACTOR = { userId: null, source: 'test' };

describe('proxy pool maintenance', () => {
  let db: DbClient;

  beforeAll(async () => {
    process.env['EGRESS_MODE'] = 'REQUIRED';
    process.env['MASTER_KEYS'] = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
    process.env['PROXY_PROBE_INTERVAL_SECONDS'] = '60';
    resetConfigCache();
    getConfig();
    db = await PGliteClient.create();
    await migrateUp(db, { skipLock: true, appliedBy: 'integration-test' });
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    resetConfigCache();
  });

  it('probes never-validated proxies and reports pool totals', async () => {
    const ring = createKeyRing({ k1: Buffer.alloc(32, 7).toString('base64') }, 'k1');
    const admin = new ProxyAdminService(db, ring);
    const view = await admin.create({ label: 'maint-1', protocol: 'HTTP', host: '10.7.0.1', port: 8080 }, ACTOR);

    const result = await runProxyMaintenance(db);
    // The unroutable probe fails (sandbox has no egress) — the point is that the loop runs,
    // records the sample and computes totals without throwing.
    expect(result.poolTotals.all).toBeGreaterThanOrEqual(1);
    const row = await db.query<{ last_failure_at: Date | null; last_success_at: Date | null }>(
      'SELECT last_failure_at, last_success_at FROM proxies WHERE id = $1',
      [view.id],
    );
    expect(row[0]!.last_failure_at).not.toBeNull();
    expect(row[0]!.last_success_at).toBeNull();
  }, 60_000);

  it('raises the exhausted signal when every enabled proxy is quarantined', async () => {
    // Hermetic: only the quarantined proxy of this test is enabled.
    await db.query('UPDATE proxies SET enabled = false');
    const ring = createKeyRing({ k1: Buffer.alloc(32, 7).toString('base64') }, 'k1');
    const admin = new ProxyAdminService(db, ring);
    const pool = new ProxyPool(db, ring, { egressMode: 'REQUIRED' });
    const view = await admin.create({ label: 'maint-2', protocol: 'HTTP', host: '10.7.0.2', port: 8080 }, ACTOR);
    await pool.recordHealth(view.id, { ok: false, source: 'TRAFFIC', httpStatus: 429, errorClass: 'RATE_LIMIT' });

    const result = await runProxyMaintenance(db);
    expect(result.notifications).toContain('proxy_pool_exhausted');
  }, 60_000);
});
