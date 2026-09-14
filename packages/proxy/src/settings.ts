/**
 * Pool-wide settings stored in `system_settings` (key `proxy_pool`), read-through cached.
 * Admin toggles go through `ProxySettingsService`; the pool reads via `load()` at lease time.
 */
import type { DbClient } from '@raja/database';
import type { EgressMode } from '@raja/shared';

export interface ProxyPoolSettings {
  egressMode: EgressMode;
  minHealthScore: number;
  probeIntervalSeconds: number;
  /** Fallback when egress mode is OPTIONAL and no proxy is available. */
  allowDirectFallback: boolean;
}

export const DEFAULT_PROXY_POOL_SETTINGS: ProxyPoolSettings = {
  egressMode: 'OFF',
  minHealthScore: 0,
  probeIntervalSeconds: 300,
  allowDirectFallback: true,
};

const SETTINGS_KEY = 'proxy_pool';

export function normalizeSettings(raw: unknown): ProxyPoolSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const egressMode = source['egressMode'];
  const minHealth = source['minHealthScore'];
  const probe = source['probeIntervalSeconds'];
  return {
    egressMode: egressMode === 'OPTIONAL' || egressMode === 'REQUIRED' ? egressMode : 'OFF',
    minHealthScore: typeof minHealth === 'number' && minHealth >= 0 && minHealth <= 100 ? Math.round(minHealth) : DEFAULT_PROXY_POOL_SETTINGS.minHealthScore,
    probeIntervalSeconds: typeof probe === 'number' && probe >= 60 && probe <= 3600 ? Math.round(probe) : DEFAULT_PROXY_POOL_SETTINGS.probeIntervalSeconds,
    allowDirectFallback: source['allowDirectFallback'] === false ? false : DEFAULT_PROXY_POOL_SETTINGS.allowDirectFallback,
  };
}

/** Read settings (defaults when absent). */
export async function loadProxySettings(db: DbClient): Promise<ProxyPoolSettings> {
  const rows = await db.query<{ value: unknown }>('SELECT value FROM system_settings WHERE key = $1', [SETTINGS_KEY]);
  return normalizeSettings(rows[0]?.value);
}

/** Persist settings (upsert). */
export async function saveProxySettings(db: DbClient, settings: ProxyPoolSettings): Promise<void> {
  await db.query(
    `INSERT INTO system_settings (key, value, description)
     VALUES ($1, $2::jsonb, 'Egress proxy pool settings (docs/proxy-pool.md)')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now()`,
    [SETTINGS_KEY, JSON.stringify(settings)],
  );
}

export class ProxySettingsService {
  constructor(private readonly db: DbClient) {}

  async get(): Promise<ProxyPoolSettings> {
    return loadProxySettings(this.db);
  }

  async update(patch: Partial<ProxyPoolSettings>): Promise<ProxyPoolSettings> {
    const current = await this.get();
    const next = normalizeSettings({ ...current, ...patch });
    await saveProxySettings(this.db, next);
    return next;
  }
}
