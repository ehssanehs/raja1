/**
 * Scheduler-side proxy pool maintenance loop.
 *
 * Runs (conceptually) every tick alongside the fairness/rate-limit loops:
 *  1. PROBE — probe proxies whose rest window elapsed or that have never been validated, through
 *     a neutral target. Successful probes release quarantine and (gradually) restore budgets.
 *  2. DEGRADED/EXHAUSTED — raise ops notifications when the healthy pool shrinks or empties.
 *
 * The loop is deliberately *not* a rotation engine: it never reassigns workers to bypass a
 * restriction signal — it only validates, rests and recovers (ADR-0008).
 */
import { getConfig } from '@raja/config';
import { PgClient, PGliteClient, type DbClient } from '@raja/database';
import { createKeyRing } from '@raja/crypto';
import { loggerFor } from '@raja/logging';
import { PROXIES_DUE_FOR_PROBE_SQL, ProxyPool, ProxyProber, pruneHealthSamples } from '@raja/proxy';
import type { ProxyRecord } from '@raja/proxy';

const log = loggerFor('scheduler.proxy');

export interface MaintenanceResult {
  probed: { proxyId: string; ok: boolean; note: string }[];
  poolTotals: { all: number; active: number; quarantined: number; dead: number; disabled: number };
  notifications: string[];
}

/** One maintenance pass. Throws nothing; every failure is logged and surfaced in the result. */
export async function runProxyMaintenance(db: DbClient): Promise<MaintenanceResult> {
  const config = getConfig();
  const ring = createKeyRing(config.crypto.masterKeys, config.crypto.activeKeyId);
  const pool = new ProxyPool(db, ring, {
    egressMode: config.proxy.egressMode,
    minHealthScore: config.proxy.minHealthScore,
    probeIntervalSeconds: config.proxy.probeIntervalSeconds,
  });
  const prober = new ProxyProber(db, pool, { probeIntervalSeconds: config.proxy.probeIntervalSeconds });

  const notifications: string[] = [];
  let probed: { proxyId: string; ok: boolean; note: string }[] = [];
  try {
    const due = await db.query<ProxyRecord>(PROXIES_DUE_FOR_PROBE_SQL);
    probed = await prober.probeRows(due);
    if (probed.length > 0) {
      log.info({ count: probed.length, ok: probed.filter((p) => p.ok).length }, 'proxy probes completed');
    }
  } catch (error) {
    log.error({ err: (error as Error).message }, 'proxy probing failed');
    notifications.push('proxy_probe_failed');
  } finally {
    await prober.close().catch(() => undefined);
  }

  try {
    const pruned = await pruneHealthSamples(db, config.retention.diagnosticsDays);
    if (pruned > 0) log.info({ pruned }, 'proxy health samples pruned');
  } catch (error) {
    log.error({ err: (error as Error).message }, 'proxy sample pruning failed');
  }

  const snapshot = await pool.snapshot();
  if (config.proxy.egressMode !== 'OFF' && snapshot.totals.all > 0) {
    const usable = snapshot.totals.active;
    if (usable === 0 && snapshot.totals.quarantined > 0) {
      notifications.push('proxy_pool_exhausted');
      log.error({ totals: snapshot.totals }, 'proxy pool exhausted: every proxy is resting or dead');
    } else if (usable <= Math.max(1, Math.floor(snapshot.totals.all / 4))) {
      notifications.push('proxy_pool_degraded');
      log.warn({ totals: snapshot.totals }, 'proxy pool degraded');
    }
  }
  return { probed, poolTotals: snapshot.totals, notifications };
}

/** Open the platform database connection for the scheduler process. */
export async function openDb(): Promise<DbClient> {
  const config = getConfig();
  if (config.db.url) {
    return PgClient.create({ connectionString: config.db.url, ssl: config.db.ssl, max: config.db.poolMax });
  }
  return PGliteClient.create();
}

/** Long-running maintenance loop (RAJA_BOOTSTRAP_SCHEDULER=1 runs this from the app entry). */
export async function runProxyMaintenanceLoop(intervalMs = 60_000): Promise<void> {
  const db = await openDb();
  let stopping = false;
  const stop = async () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runProxyMaintenance(db);
    } catch (error) {
      log.error({ err: (error as Error).message }, 'proxy maintenance pass failed');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await db.close().catch(() => undefined);
}

if (process.env['RAJA_BOOTSTRAP_SCHEDULER'] === '1') {
  runProxyMaintenanceLoop().catch((error) => {
    log.fatal({ err: (error as Error).message }, 'scheduler proxy loop failed to start');
    process.exit(1);
  });
}
