/**
 * Pure proxy-selection (rotation) logic — no I/O, fully unit-testable.
 *
 * Semantics (documented in docs/proxy-pool.md):
 *  - Only ENABLED, ACTIVE (not quarantined/dead), healthy-enough proxies are candidates.
 *  - Provider affinity: a proxy pinned to a provider serves that provider; unassigned proxies
 *    serve any. A proxy pinned to provider A is never handed out for provider B.
 *  - Sticky per worker: a worker keeps its currently assigned proxy until the proxy becomes
 *    unhealthy/quarantined or the admin-defined rotation window elapses.
 *  - On rotation the least-recently-*rotated* healthy proxy is preferred — even wear across the
 *    pool, and never a fast rotation. Rotation timing is admin-defined (≥ 5 minutes).
 *  - There is deliberately NO mode that rotates on provider restriction signals; restrictions
 *    produce rest (quarantine) for the affected proxy only (see quarantine.ts).
 */
import type { ProxyRecord } from './types';
import type { ProxyUnavailableReason } from './types';

export interface SelectableProxy {
  id: string;
  label: string;
  providerCode: string | null;
  enabled: boolean;
  status: ProxyRecord['status'];
  healthScore: number;
  quarantinedUntil: Date | null;
  rotationSeconds: number;
  assignedWorkerId: string | null;
  lastRotatedAt: Date | null;
}

export interface SelectionInput {
  proxies: readonly SelectableProxy[];
  now: Date;
  /** Pool egress mode: OFF disables the pool entirely. */
  egressMode: 'OFF' | 'OPTIONAL' | 'REQUIRED';
  /** Provider the traffic is destined to (affinity filter); null/undefined = any. */
  providerCode?: string | null;
  /** Worker asking for an egress; drives stickiness. */
  workerId: string;
  /** Proxies below this health score are not handed out (0 disables the floor). */
  minHealthScore?: number;
}

export interface SelectionOutcome {
  selected: SelectableProxy | null;
  /** True when the sticky assignment was kept (no rotation happened). */
  sticky: boolean;
  /** True when the rotation window of the sticky proxy elapsed and we moved on purpose. */
  rotated: boolean;
  reason: string;
  /** When nothing was selected: the dominant reason, for ops dashboards. */
  unavailableReason?: ProxyUnavailableReason;
}

function isQuarantined(proxy: SelectableProxy, now: Date): boolean {
  return proxy.status === 'QUARANTINED' || (proxy.quarantinedUntil !== null && proxy.quarantinedUntil.getTime() > now.getTime());
}

function rotationDue(proxy: SelectableProxy, now: Date): boolean {
  if (!proxy.lastRotatedAt) return true;
  return now.getTime() - proxy.lastRotatedAt.getTime() >= proxy.rotationSeconds * 1000;
}

/** Deterministic ordering: health desc, then least-recently rotated, then id (stable tiebreak). */
function compareCandidates(a: SelectableProxy, b: SelectableProxy): number {
  if (a.healthScore !== b.healthScore) return b.healthScore - a.healthScore;
  const aTime = a.lastRotatedAt?.getTime() ?? 0;
  const bTime = b.lastRotatedAt?.getTime() ?? 0;
  if (aTime !== bTime) return aTime - bTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Select the proxy a worker should use right now, or explain why none is available.
 * The function never throws; every "no" carries a machine-readable reason.
 */
export function selectProxy(input: SelectionInput): SelectionOutcome {
  const { proxies, now, workerId } = input;
  if (input.egressMode === 'OFF') {
    return { selected: null, sticky: false, rotated: false, reason: 'POOL_DISABLED', unavailableReason: 'POOL_DISABLED' };
  }
  if (proxies.length === 0) {
    return { selected: null, sticky: false, rotated: false, reason: 'POOL_EMPTY', unavailableReason: 'NO_PROXIES' };
  }

  const minHealth = input.minHealthScore ?? 0;
  const provider = input.providerCode ?? null;

  const eligible = proxies.filter((proxy) => {
    if (!proxy.enabled) return false;
    if (isQuarantined(proxy, now)) return false;
    if (proxy.status === 'DEAD') return false;
    if (proxy.healthScore < minHealth) return false;
    if (proxy.providerCode !== null && provider !== null && proxy.providerCode !== provider) return false;
    return true;
  });

  if (eligible.length === 0) {
    const unavailableReason = classifyUnavailable(proxies, now, minHealth, provider);
    return { selected: null, sticky: false, rotated: false, reason: unavailableReason, unavailableReason };
  }

  // 1) Sticky: keep the worker's current proxy while it is eligible and inside its rotation window.
  const sticky = workerId ? eligible.find((proxy) => proxy.assignedWorkerId === workerId) : undefined;
  if (sticky && !rotationDue(sticky, now)) {
    return { selected: sticky, sticky: true, rotated: false, reason: 'STICKY' };
  }

  // 2) Rotation due (or no assignment): prefer a *different* healthy proxy, least-recently rotated.
  const candidates = eligible.filter((proxy) => proxy.id !== sticky?.id).sort(compareCandidates);
  const choice = candidates[0] ?? sticky;
  if (!choice) {
    return { selected: null, sticky: false, rotated: false, reason: 'NO_CANDIDATE', unavailableReason: 'ALL_UNHEALTHY' };
  }
  return {
    selected: choice,
    sticky: false,
    rotated: Boolean(sticky),
    reason: sticky ? 'ROTATED_SCHEDULE' : choice.assignedWorkerId ? 'REASSIGNED' : 'LEAST_RECENTLY_ROTATED',
  };
}

function classifyUnavailable(
  proxies: readonly SelectableProxy[],
  now: Date,
  minHealth: number,
  provider: string | null,
): ProxyUnavailableReason {
  const relevant = proxies.filter((proxy) => provider === null || proxy.providerCode === null || proxy.providerCode === provider);
  if (relevant.length === 0) return 'PROVIDER_MISMATCH';
  if (relevant.every((proxy) => !proxy.enabled)) return 'ALL_DISABLED';
  if (relevant.every((proxy) => proxy.status === 'DEAD')) return 'ALL_DEAD';
  if (relevant.every((proxy) => isQuarantined(proxy, now))) return 'ALL_QUARANTINED';
  if (relevant.every((proxy) => proxy.healthScore < minHealth)) return 'ALL_UNHEALTHY';
  return 'ALL_QUARANTINED';
}
