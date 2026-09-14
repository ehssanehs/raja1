/**
 * Retention helpers for the proxy pool's evidence tables.
 *
 * `proxy_events` is fully append-only (audit): never deleted, history is kept with `proxy_id`
 * NULLed after the proxy is removed. `proxy_health_samples` is never editable but rows older
 * than the retention window are pruned by the scheduler maintenance loop — the same lifecycle
 * as diagnostics artifacts (`RETENTION_DIAGNOSTICS_DAYS`, default 14 days).
 */
import type { DbClient, QueryResultRow } from '@raja/database';

/** Delete health samples older than `retentionDays`. Returns the number of pruned rows. */
export async function pruneHealthSamples(db: DbClient, retentionDays: number): Promise<number> {
  const days = Math.max(1, Math.round(retentionDays));
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM proxy_health_samples
      WHERE created_at < now() - make_interval(days => $1)
      RETURNING id`,
    [days],
  );
  return deleted.length;
}

/** Row shape returned by the samples API (trend charts). */
export interface ProxyHealthSampleView extends QueryResultRow {
  id: string;
  proxy_id: string;
  source: 'PROBE' | 'TRAFFIC';
  ok: boolean;
  latency_ms: number | null;
  http_status: number | null;
  error_class: string | null;
  block_page: boolean;
  captcha_seen: boolean;
  created_at: Date;
}
