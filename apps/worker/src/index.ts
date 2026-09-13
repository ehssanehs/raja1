/**
 * Worker runtime (bootstrap kept explicit and small):
 *  - acquires an egress lease for this worker process when the proxy pool is enabled
 *  - reports health of that egress back to the pool after every provider call
 *  - re-acquires on revocation/quarantine; never rotates on restriction signals (ADR-0008)
 *
 * This file intentionally contains no queue wiring yet: worker pipelines are added milestone by
 * milestone. It exists so the egress lifecycle is exercised end-to-end as soon as a worker boots.
 */
import { randomUUID } from 'node:crypto';
import { getConfig } from '@raja/config';
import { PgClient, type DbClient } from '@raja/database';
import { createKeyRing } from '@raja/crypto';
import { loggerFor } from '@raja/logging';
import { ProxyPool } from '@raja/proxy';
import type { ProxyLease } from '@raja/proxy';

const log = loggerFor('worker');

export interface WorkerRuntime {
  workerId: string;
  db: DbClient;
  pool: ProxyPool;
  lease: ProxyLease | null;
  /** Ensure an egress lease exists (no-op when the pool is OFF or already leased). */
  ensureEgress(): Promise<ProxyLease | null>;
  /** Report one provider call outcome through the leased egress. */
  reportEgressHealth(input: { ok: boolean; httpStatus?: number | null; errorClass?: string | null; captchaSeen?: boolean; blockPage?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export async function startWorker(): Promise<WorkerRuntime> {
  const config = getConfig();
  const db = config.db.url
    ? await PgClient.create({ connectionString: config.db.url, ssl: config.db.ssl, max: config.db.poolMax })
    : await (async () => {
        const { PGliteClient } = await import('@raja/database');
        return PGliteClient.create();
      })();
  const ring = createKeyRing(config.crypto.masterKeys, config.crypto.activeKeyId);
  const pool = new ProxyPool(db, ring, {
    egressMode: config.proxy.egressMode,
    minHealthScore: config.proxy.minHealthScore,
    probeIntervalSeconds: config.proxy.probeIntervalSeconds,
  });
  const runtime: WorkerRuntime = {
    workerId: `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
    db,
    pool,
    lease: null,
    async ensureEgress() {
      if (this.lease) return this.lease;
      try {
        this.lease = await pool.acquire(this.workerId, { ttlMs: config.proxy.leaseSeconds * 1000 });
        log.info({ proxyId: this.lease.proxyId, label: this.lease.label, rpm: this.lease.requestsPerMinute }, 'egress lease acquired');
        return this.lease;
      } catch (error) {
        log.warn({ reason: (error as { reason?: string }).reason ?? 'unknown' }, 'no egress lease available');
        return null;
      }
    },
    async reportEgressHealth(input) {
      if (!this.lease) return;
      await pool.recordHealth(this.lease.proxyId, {
        ok: input.ok,
        source: 'TRAFFIC',
        httpStatus: input.httpStatus ?? null,
        errorClass: (input.errorClass ?? null) as import('@raja/shared').FailureClass | null,
        captchaSeen: input.captchaSeen,
        blockPage: input.blockPage,
      });
      // A quarantine frees the assignment inside recordHealth; drop our handle so the next call
      // re-acquires (possibly nothing — then the caller must back off, not switch IP and push on).
      const row = await db.query<{ status: string }>('SELECT status FROM proxies WHERE id = $1', [this.lease.proxyId]);
      if (row[0] && row[0].status !== 'ACTIVE') {
        log.warn({ proxyId: this.lease.proxyId, status: row[0].status }, 'egress entered rest; next call re-acquires');
        this.lease = null;
      }
    },
    async close() {
      if (this.lease) {
        await pool.release(this.workerId, this.lease.proxyId).catch(() => undefined);
        this.lease = null;
      }
      await db.close();
    },
  };
  return runtime;
}

// Executable bootstrap (container entrypoint). Queue consumers attach in the queue milestone;
// today the runtime starts, holds its identity and drains its egress lease on shutdown.
if (process.env['RAJA_BOOTSTRAP_WORKER'] === '1') {
  startWorker()
    .then((worker) => {
      log.info({ workerId: worker.workerId, egressMode: getConfig().proxy.egressMode }, 'worker runtime started');
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const heartbeat = setInterval(() => {
        if (!stopping) return;
        clearInterval(heartbeat);
        void worker
          .close()
          .catch(() => undefined)
          .then(() => process.exit(0));
      }, 500);
    })
    .catch((error: unknown) => {
      log.fatal({ err: (error as Error).message }, 'worker failed to start');
      process.exit(1);
    });
}
