/**
 * Admin API — proxy pool management (bootstrap).
 *
 * A compact Fastify server exposing `/api/v1/admin/proxies` CRUD + pool settings + health
 * operations, guarded by the RBAC permission `proxy:manage`. Routes are thin: validation via
 * zod, all logic lives in `@raja/proxy` services (tested there, not here).
 *
 * The full NestJS application shell lands with the API milestone; this server is the
 * admin-surface slice of it, runnable today (`node dist/index.js`).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { getConfig, ConfigError } from '@raja/config';
import { loggerFor } from '@raja/logging';
import { PgClient, PGliteClient, migrateUp, type DbClient } from '@raja/database';
import { createKeyRing } from '@raja/crypto';
import { unauthenticated, AppError, EGRESS_MODES, PROXY_PROTOCOLS } from '@raja/shared';
import { ProxyAdminService, ProxyPool, ProxySettingsService } from '@raja/proxy';

const log = loggerFor('api.admin.proxies');

const createProxySchema = z.object({
  label: z.string().min(1).max(120),
  protocol: z.enum(PROXY_PROTOCOLS),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().max(200).nullish(),
  password: z.string().max(500).nullish(),
  providerCode: z.string().max(40).nullish(),
  region: z.string().max(80).nullish(),
  rotationSeconds: z.coerce.number().int().min(300).max(86_400).nullish(),
  requestsPerMinute: z.coerce.number().int().min(1).max(60).nullish(),
});

const updateProxySchema = createProxySchema.partial();

const settingsSchema = z.object({
  egressMode: z.enum(EGRESS_MODES).optional(),
  minHealthScore: z.coerce.number().int().min(0).max(100).optional(),
  probeIntervalSeconds: z.coerce.number().int().min(60).max(3600).optional(),
  allowDirectFallback: z.boolean().optional(),
});

export interface AdminApiOptions {
  /** Bearer token required on every admin route (dev default; set a real token in prod). */
  adminToken?: string;
  port?: number;
  host?: string;
}

export async function startAdminApi(options: AdminApiOptions = {}): Promise<{ server: ReturnType<typeof Fastify>; db: DbClient; port: number; close(): Promise<void> }> {
  const config = getConfig();
  const adminToken = options.adminToken ?? process.env['ADMIN_API_TOKEN'] ?? 'dev-admin-token-change-me';

  const db = config.db.url
    ? await PgClient.create({ connectionString: config.db.url, ssl: config.db.ssl, max: config.db.poolMax })
    : await PGliteClient.create();
  await migrateUp(db, { appliedBy: 'api-bootstrap' });

  const ring = createKeyRing(config.crypto.masterKeys, config.crypto.activeKeyId);
  const admin = new ProxyAdminService(db, ring);
  const settings = new ProxySettingsService(db);
  const pool = new ProxyPool(db, ring, {
    egressMode: config.proxy.egressMode,
    minHealthScore: config.proxy.minHealthScore,
    probeIntervalSeconds: config.proxy.probeIntervalSeconds,
  });

  const app = Fastify({ logger: false });
  const url = `http://${options.host ?? '0.0.0.0'}:${options.port ?? config.http.apiPort}`;

  // ----- auth guard (bearer token; RBAC integration lands with the API milestone) -----
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(config.http.apiBasePath)) return;
    const header = request.headers['authorization'];
    if (header !== `Bearer ${adminToken}`) {
      const error = unauthenticated('admin token required');
      await reply.code(error.statusCode).send(error.toPublicJson());
    }
  });

  // ----- error mapping -----
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      void reply.code(error.statusCode).send(error.toPublicJson());
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.code(422).send({ error: { code: 'VALIDATION_FAILED', messageKey: 'error.validation_failed', issues: error.issues.map((i) => i.path.join('.')) } });
      return;
    }
    log.error({ err: (error as Error).message }, 'unhandled admin api error');
    void reply.code(500).send({ error: { code: 'INTERNAL_ERROR', messageKey: 'error.internal_error' } });
  });

  // ------------------------------- routes -------------------------------
  const base = config.http.apiBasePath;

  // Admin console: static HTML (Persian/RTL). The page itself carries no data — every API call
  // it makes is bearer-guarded below. Served outside apiBasePath, so the auth hook skips it.
  app.get('/admin', async (_request, reply) => {
    const html = await readFile(consoleHtmlPath(), 'utf8');
    void reply.header('content-type', 'text/html; charset=utf-8');
    void reply.header('cache-control', 'no-store');
    return html;
  });

  app.get(`${base}/admin/proxies`, async () => admin.list());

  app.get(`${base}/admin/proxies/pool`, async () => {
    const current = await settings.get();
    pool.updateSettings({ egressMode: current.egressMode, minHealthScore: current.minHealthScore, probeIntervalSeconds: current.probeIntervalSeconds });
    return pool.snapshot();
  });

  app.get(`${base}/admin/proxies/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const proxy = await admin.get(id);
    if (!proxy) return reply.code(404).send({ error: { code: 'NOT_FOUND', messageKey: 'error.not_found' } });
    return proxy;
  });

  app.get(`${base}/admin/proxies/:id/events`, async (request) => {
    const { id } = request.params as { id: string };
    return admin.events(id);
  });

  app.post(`${base}/admin/proxies`, async (request, reply) => {
    const input = createProxySchema.parse(request.body);
    const actor = { userId: actorOf(request.headers), source: 'web:admin' };
    const proxy = await admin.create(input, actor);
    void reply.code(201);
    return proxy;
  });

  app.patch(`${base}/admin/proxies/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const input = updateProxySchema.parse(request.body);
    const actor = { userId: actorOf(request.headers), source: 'web:admin' };
    return admin.update(id, input, actor);
  });

  app.post(`${base}/admin/proxies/:id/enable`, async (request) => {
    const { id } = request.params as { id: string };
    const actor = { userId: actorOf(request.headers), source: 'web:admin' };
    return admin.setEnabled(id, true, actor);
  });

  app.post(`${base}/admin/proxies/:id/disable`, async (request) => {
    const { id } = request.params as { id: string };
    const actor = { userId: actorOf(request.headers), source: 'web:admin' };
    return admin.setEnabled(id, false, actor);
  });

  app.delete(`${base}/admin/proxies/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const actor = { userId: actorOf(request.headers), source: 'web:admin' };
    await admin.remove(id, actor);
    return { ok: true };
  });

  app.get(`${base}/admin/proxy-settings`, async () => settings.get());

  app.put(`${base}/admin/proxy-settings`, async (request) => {
    const patch = settingsSchema.parse(request.body);
    const next = await settings.update(patch);
    pool.updateSettings({ egressMode: next.egressMode, minHealthScore: next.minHealthScore, probeIntervalSeconds: next.probeIntervalSeconds });
    return next;
  });

  await app.listen({ port: options.port ?? config.http.apiPort, host: options.host ?? '0.0.0.0' });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : config.http.apiPort;
  log.info({ url, port: boundPort, egressMode: config.proxy.egressMode }, 'admin proxy api listening');

  return {
    server: app,
    db,
    port: boundPort,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** Locate console.html across CJS dist, vite-node/tsx and repo-root execution. */
function consoleHtmlPath(): string {
  const here = (() => {
    try {
      // CJS build (and vite-node) both define __filename; guard for exotic ESM runners.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filename = (globalThis as Record<string, unknown>)['__filename'];
      if (typeof filename === 'string') return dirname(filename);
    } catch { /* fall through to cwd */ }
    return process.cwd();
  })();
  const candidates = [
    join(here, 'console.html'),
    join(here, 'src', 'console.html'),
    join(process.cwd(), 'apps', 'api', 'src', 'console.html'),
    join(process.cwd(), 'src', 'console.html'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function actorOf(headers: Record<string, unknown>): string | null {
  // Placeholder subject until the JWT guard lands; the audit trail keeps the token source tag.
  void headers;
  return null;
}

// Executable bootstrap (tsx/node). Importing modules should not start a server.
if (process.env['RAJA_BOOTSTRAP_ADMIN_API'] === '1') {
  startAdminApi().catch((error) => {
    if (error instanceof ConfigError) {
      log.fatal({ issues: error.issues }, 'invalid configuration; refusing to start');
    } else {
      log.fatal({ err: (error as Error).message }, 'admin api failed to start');
    }
    process.exit(1);
  });
}
