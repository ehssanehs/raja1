/**
 * Scheduled prober: pings proxies that are due (quarantine elapsed, health unknown, or periodic)
 * through a NEUTRAL target so a probe never looks like provider traffic, then feeds the sample
 * into the pool. Recovery path: QUARANTINED --probe ok after rest--> ACTIVE (budget restored
 * gradually); DEAD needs a manual admin re-enable OR a successful probe (both recorded).
 */
import type { DbClient } from '@raja/database';
import { ProxyPool } from './pool';
import { ProxiedHttpClient } from './transport';
import type { ProxyRecord } from './types';

export interface ProberOptions {
  /** Neutral connectivity target. Never the provider (probes must not look like scraping). */
  targetUrl?: string;
  maxPerRun?: number;
  probeIntervalSeconds?: number;
}

export const NEUTRAL_PROBE_TARGET = 'https://www.gstatic.com/generate_204';

export class ProxyProber {
  private readonly http: ProxiedHttpClient;

  constructor(private readonly db: DbClient, private readonly pool: ProxyPool, options: ProberOptions = {}) {
    this.http = new ProxiedHttpClient();
    this.targetUrl = options.targetUrl ?? NEUTRAL_PROBE_TARGET;
    this.maxPerRun = options.maxPerRun ?? 10;
  }

  private targetUrl: string;
  private maxPerRun: number;

  /**
   * Probe all due proxies once. Returns the proxy ids probed with their outcome.
   * Due set: quarantined whose rest window elapsed, dead-adjacent, and ACTIVE proxies that have
   * never been probed (fail-fast surface for typos/dead entries added by admins).
   */
  async probeDue(): Promise<{ proxyId: string; ok: boolean; note: string }[]> {
    const rows = await this.db.query<ProxyRecord>('SELECT * FROM probes_due_view');
    return this.probeRows(rows);
  }

  /**
   * Probing directly over a row list keeps the SQL simple and lets the scheduler pass its own
   * due-set query. Public so tests can drive it deterministically.
   */
  async probeRows(rows: readonly ProxyRecord[]): Promise<{ proxyId: string; ok: boolean; note: string }[]> {
    const results: { proxyId: string; ok: boolean; note: string }[] = [];
    for (const row of rows.slice(0, this.maxPerRun)) {
      results.push(await this.probeOne(row));
    }
    return results;
  }

  /** Probe a single proxy and record the outcome in the pool. */
  async probeOne(row: ProxyRecord): Promise<{ proxyId: string; ok: boolean; note: string }> {
    try {
      const resolved = await this.pool.resolveById(row.id);
      const response = await this.http.probe(resolved, this.targetUrl, 8000);
      const ok = response.status < 500 && response.status !== 407 && response.status !== 429;
      await this.pool.recordHealth(row.id, {
        ok,
        source: 'PROBE',
        latencyMs: response.durationMs,
        httpStatus: response.status,
        errorClass: ok ? null : response.status === 429 ? 'RATE_LIMIT' : response.status === 407 ? 'AUTH' : 'NETWORK',
      });
      return { proxyId: row.id, ok, note: ok ? `status ${response.status}` : `probe status ${response.status}` };
    } catch (error) {
      const isProtocol = (error as { name?: string }).name === 'ProxyProtocolUnsupportedError';
      await this.pool.recordHealth(row.id, {
        ok: false,
        source: 'PROBE',
        latencyMs: null,
        httpStatus: null,
        errorClass: isProtocol ? 'VALIDATION' : 'NETWORK',
      });
      return { proxyId: row.id, ok: false, note: isProtocol ? 'protocol unsupported' : 'connection failed' };
    }
  }

  async close(): Promise<void> {
    await this.http.close();
  }
}
