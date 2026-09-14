#!/usr/bin/env node
/**
 * `demo:console` — boots the admin API + web console against an embedded PostgreSQL (PGlite,
 * in-memory) seeded with a *clearly fictional* proxy pool so the UI can be explored end to end:
 *
 *   three proxies (healthy / quarantined-with-rest-window / dead), an assignment each, realistic
 *   health-sample history over the last ~12 hours (latency curves, 429s, a CAPTCHA flag), and
 *   audit events telling the story.
 *
 * No real network, no real proxies, nothing persisted — kill the process and it is gone.
 * Usage: npm run demo:console  →  http://localhost:3001/admin (token: dev-admin-token-change-me)
 */
import { randomUUID } from 'node:crypto';
import { getConfig } from '@raja/config';
import { PGliteClient, migrateUp, type DbClient } from '@raja/database';
import { createKeyRing } from '@raja/crypto';
import { loggerFor } from '@raja/logging';
import { ProxyAdminService, ProxyPool } from '@raja/proxy';
import { startAdminApi } from '../apps/api/src/index';

const log = loggerFor('demo.console');

const TOKEN = process.env['ADMIN_API_TOKEN'] ?? 'dev-admin-token-change-me';
const PORT = Number(process.env['API_PORT'] ?? 3001);

interface DemoProxy {
  label: string;
  host: string;
  region: string;
  providerCode: string | null;
  rpm: number;
  rotationSeconds: number;
  health: number;
  status: 'ACTIVE' | 'QUARANTINED' | 'DEAD';
  workerId: string | null;
  budgetPct: number;
  quarantinedUntil: Date | null;
  success: number;
  failure: number;
  /** Sample history shape: ok latency list + failure/captcha positions. */
  latencyBase: number;
  jitter: number;
  failures: number[];
  captchaAt?: number[];
  story: { at: string; type: string; source: string; reason: string }[];
}

const DEMO: DemoProxy[] = [
  {
    label: 'dc-tehran-1',
    host: '203.0.113.10',
    region: 'IR-Tehran',
    providerCode: 'raja',
    rpm: 10,
    rotationSeconds: 3600,
    health: 92,
    status: 'ACTIVE',
    workerId: 'worker-7f3a21',
    budgetPct: 100,
    quarantinedUntil: null,
    success: 412,
    failure: 9,
    latencyBase: 340,
    jitter: 60,
    failures: [17, 41],
    story: [
      { at: '9h', type: 'LEASE_ACQUIRED', source: 'pool:worker-7f3a21', reason: 'STICKY' },
      { at: '2h', type: 'PROBE_OK', source: 'probe', reason: 'probe status 204' },
    ],
  },
  {
    label: 'dc-tabriz-2',
    host: '198.51.100.24',
    region: 'IR-Tabriz',
    providerCode: null,
    rpm: 10,
    rotationSeconds: 1800,
    health: 46,
    status: 'QUARANTINED',
    workerId: null,
    budgetPct: 25,
    quarantinedUntil: new Date(Date.now() + 38 * 60_000),
    success: 87,
    failure: 21,
    latencyBase: 610,
    jitter: 140,
    failures: [9, 10, 23],
    captchaAt: [10],
    story: [
      { at: '3h', type: 'QUARANTINED', source: 'traffic', reason: 'RATE_LIMITED_BY_PROVIDER' },
      { at: '1h', type: 'QUARANTINED', source: 'traffic', reason: 'REPEATED_CAPTCHA_CHALLENGES' },
    ],
  },
  {
    label: 'backup-shiraz-3',
    host: '192.0.2.77',
    region: 'IR-Shiraz',
    providerCode: null,
    rpm: 5,
    rotationSeconds: 7200,
    health: 8,
    status: 'DEAD',
    workerId: null,
    budgetPct: 12,
    quarantinedUntil: null,
    success: 12,
    failure: 58,
    latencyBase: 1500,
    jitter: 400,
    failures: [2, 4, 5, 8, 11, 12, 14],
    story: [
      { at: '6h', type: 'MARKED_DEAD', source: 'probe', reason: 'sustained hard failures' },
    ],
  },
];

async function seed(db: DbClient): Promise<void> {
  const ring = createKeyRing(getConfig().crypto.masterKeys, getConfig().crypto.activeKeyId);
  const admin = new ProxyAdminService(db, ring);
  const pool = new ProxyPool(db, ring, { egressMode: 'OPTIONAL', probeIntervalSeconds: 300 });

  for (const spec of DEMO) {
    const view = await admin.create(
      {
        label: spec.label,
        protocol: 'HTTP',
        host: spec.host,
        port: 8080,
        username: `demo-${spec.label.split('-')[1]}`,
        password: 'demo-only-not-a-real-credential',
        providerCode: spec.providerCode,
        region: spec.region,
        rotationSeconds: spec.rotationSeconds,
        requestsPerMinute: spec.rpm,
      },
      { userId: null, source: 'demo' },
    );

    await db.query(
      `UPDATE proxies SET
         health_score = $2, status = $3, assigned_worker_id = $4, assigned_at = now() - interval '90 minutes',
         last_rotated_at = now() - interval '35 minutes', rate_budget_multiplier_pct = $5,
         quarantined_until = $6, success_count = $7, failure_count = $8,
         last_success_at = now() - interval '6 minutes', last_failure_at = now() - interval '52 minutes',
         last_error_class = $9
       WHERE id = $1`,
      [
        view.id,
        spec.health,
        spec.status,
        spec.workerId,
        spec.budgetPct,
        spec.quarantinedUntil,
        spec.success,
        spec.failure,
        spec.status === 'DEAD' ? 'AUTH' : 'RATE_LIMIT',
      ],
    );

    // Sample history: one observation every ~12 minutes over the last 12 hours (61 samples).
    const SAMPLES = 61;
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const minutesAgo = (SAMPLES - 1 - i) * 12;
      const wave = Math.sin(i / 7) * spec.jitter;
      const drift = (i / SAMPLES) * (spec.status === 'DEAD' ? 600 : -spec.jitter / 2);
      const isFailure = spec.failures.includes(i);
      const captcha = spec.captchaAt?.includes(i) === true;
      const latency = Math.max(40, Math.round(spec.latencyBase + wave + drift));
      const source = i % 4 === 0 ? 'PROBE' : 'TRAFFIC';
      values.push(
        randomUUID(), view.id, source, !isFailure,
        isFailure ? null : latency,
        isFailure ? (i % 2 === 0 ? 429 : null) : source === 'PROBE' ? 204 : 200,
        isFailure ? 'RATE_LIMIT' : null,
        false, captcha, `demo-${Math.floor(i / 10)}`,
      );
      const p = (n: number) => `$${n}`;
      const base = rows.length * 10;
      // minutesAgo is a computed integer constant — safe (and required) to inline as SQL.
      rows.push(`(${p(base + 1)}, ${p(base + 2)}, ${p(base + 3)}, ${p(base + 4)}, ${p(base + 5)}, ${p(base + 6)}, ${p(base + 7)}, ${p(base + 8)}, ${p(base + 9)}, ${p(base + 10)}, now() - interval '${minutesAgo} minutes')`);
    }
    await db.query(
      `INSERT INTO proxy_health_samples
         (id, proxy_id, source, ok, latency_ms, http_status, error_class, block_page, captcha_seen, correlation_id, created_at)
       VALUES ${rows.join(', ')}`,
      values,
    );

    for (const event of spec.story) {
      const [amount, unit] = event.at.split(/(?=[a-z])/); // '12h' -> ['12', 'h']
      const sqlInterval = `${amount} ${{ h: 'hours', m: 'minutes' }[unit] ?? unit}`;
      await db.query(
        `INSERT INTO proxy_events (id, proxy_id, event_type, source, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '${sqlInterval}')`,
        [randomUUID(), view.id, event.type, event.source, event.reason],
      );
    }
  }
  // Settings: show the pool in OPTIONAL so the badge demonstrates an enabled (but non-required) mode.
  await db.query(
    `INSERT INTO system_settings (key, value, description)
     VALUES ('proxy_pool', '{"egressMode":"OPTIONAL","minHealthScore":0,"probeIntervalSeconds":300,"allowDirectFallback":true}'::jsonb,
             'Egress proxy pool settings (docs/proxy-pool.md)')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const _ = pool; // pool kept for future interactive demos; instantiation validates config
}

async function main(): Promise<void> {
  log.info('seeding fictional proxy pool into embedded postgres…');
  const db = await PGliteClient.create();
  await migrateUp(db, { skipLock: true, appliedBy: 'demo-seed' });
  await seed(db);

  const api = await startAdminApi({ adminToken: TOKEN, port: PORT, host: '0.0.0.0', db });
  log.info({ port: api.port, console: `http://localhost:${api.port}/admin`, token: TOKEN }, 'demo console ready');
  log.info('this data is FICTIONAL and lives only in this process memory — Ctrl+C to discard');

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const drain = setInterval(() => {
    if (!stopping) return;
    clearInterval(drain);
    void api
      .close()
      .catch(() => undefined)
      .then(() => process.exit(0));
  }, 500);
}

main().catch((error) => {
  log.fatal({ err: (error as Error).message }, 'demo console failed');
  process.exit(1);
});
