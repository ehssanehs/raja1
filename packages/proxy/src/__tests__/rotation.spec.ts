/**
 * Pure rotation semantics: stickiness, admin-scheduled rotation, provider affinity,
 * and the guarantees that make the pool respectful (no rotation-on-restriction anywhere).
 */
import { describe, expect, it } from 'vitest';
import { selectProxy, type SelectableProxy } from '../rotation';

const NOW = new Date('2026-09-12T10:00:00Z');

function proxy(overrides: Partial<SelectableProxy> = {}): SelectableProxy {
  return {
    id: 'p1',
    label: 'proxy-1',
    providerCode: null,
    enabled: true,
    status: 'ACTIVE',
    healthScore: 100,
    quarantinedUntil: null,
    rotationSeconds: 3600,
    assignedWorkerId: null,
    lastRotatedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

const baseInput = {
  proxies: [proxy()],
  now: NOW,
  egressMode: 'OPTIONAL' as const,
  workerId: 'w1',
};

describe('selectProxy', () => {
  it('returns POOL_DISABLED in OFF mode and never hands out a proxy', () => {
    const outcome = selectProxy({ ...baseInput, egressMode: 'OFF' });
    expect(outcome.selected).toBeNull();
    expect(outcome.unavailableReason).toBe('POOL_DISABLED');
  });

  it('keeps a healthy sticky assignment inside its rotation window', () => {
    const assigned = proxy({ id: 'p1', assignedWorkerId: 'w1', lastRotatedAt: new Date(NOW.getTime() - 120_000) });
    const fresher = proxy({ id: 'p2', healthScore: 100, lastRotatedAt: new Date(NOW.getTime() - 30_000) });
    const outcome = selectProxy({ ...baseInput, proxies: [assigned, fresher] });
    expect(outcome.selected?.id).toBe('p1');
    expect(outcome.sticky).toBe(true);
    expect(outcome.rotated).toBe(false);
  });

  it('rotates when the admin-defined rotation window elapsed, preferring least-recently-rotated', () => {
    const assigned = proxy({ id: 'p1', assignedWorkerId: 'w1', lastRotatedAt: new Date(NOW.getTime() - 2 * 3600_000) });
    const older = proxy({ id: 'p2', lastRotatedAt: new Date(NOW.getTime() - 90 * 60_000) });
    const newer = proxy({ id: 'p3', lastRotatedAt: new Date(NOW.getTime() - 5 * 60_000) });
    const outcome = selectProxy({ ...baseInput, proxies: [assigned, newer, older] });
    expect(outcome.selected?.id).toBe('p2');
    expect(outcome.rotated).toBe(true);
    expect(outcome.reason).toBe('ROTATED_SCHEDULE');
  });

  it('prefers healthier proxies after the sticky proxy degrades below the floor', () => {
    const sick = proxy({ id: 'p1', assignedWorkerId: 'w1', healthScore: 10 });
    const healthy = proxy({ id: 'p2', healthScore: 90 });
    const outcome = selectProxy({ ...baseInput, proxies: [sick, healthy], minHealthScore: 40 });
    expect(outcome.selected?.id).toBe('p2');
    expect(outcome.rotated).toBe(false); // health-driven replacement, not a schedule rotation
  });

  it('never selects a quarantined proxy even with nothing else available', () => {
    const resting = proxy({ id: 'p1', status: 'QUARANTINED', quarantinedUntil: new Date(NOW.getTime() + 600_000) });
    const outcome = selectProxy(baseInput.proxies ? { ...baseInput, proxies: [resting] } : baseInput);
    expect(outcome.selected).toBeNull();
    expect(outcome.unavailableReason).toBe('ALL_QUARANTINED');
  });

  it('does not reactivate a quarantined proxy on elapsed time alone — recovery requires a successful probe', () => {
    const stillResting = proxy({ id: 'p1', status: 'QUARANTINED', quarantinedUntil: new Date(NOW.getTime() - 1_000) });
    const outcome = selectProxy({ ...baseInput, proxies: [stillResting] });
    expect(outcome.selected).toBeNull();

    // Once a probe cleared it (status back to ACTIVE with a stale window), it is eligible again.
    const cleared = proxy({ id: 'p1', status: 'ACTIVE', quarantinedUntil: new Date(NOW.getTime() - 1_000) });
    const after = selectProxy({ ...baseInput, proxies: [cleared] });
    expect(after.selected?.id).toBe('p1');
  });


  it('never hands a dead proxy', () => {
    const dead = proxy({ id: 'p1', status: 'DEAD' });
    const outcome = selectProxy({ ...baseInput, proxies: [dead] });
    expect(outcome.selected).toBeNull();
    expect(outcome.unavailableReason).toBe('ALL_DEAD');
  });

  it('enforces provider affinity: a proxy pinned to another provider is not offered', () => {
    const pinned = proxy({ id: 'p1', providerCode: 'raja' });
    const outcome = selectProxy({ ...baseInput, proxies: [pinned], providerCode: 'simulator' });
    expect(outcome.selected).toBeNull();
    expect(outcome.unavailableReason).toBe('PROVIDER_MISMATCH');
  });

  it('offers an unpinned proxy to any provider', () => {
    const unpinned = proxy({ id: 'p1', providerCode: null });
    const outcome = selectProxy({ ...baseInput, proxies: [unpinned], providerCode: 'raja' });
    expect(outcome.selected?.id).toBe('p1');
  });

  it('reports ALL_DISABLED when every proxy is administratively disabled', () => {
    const disabled = proxy({ id: 'p1', enabled: false });
    const outcome = selectProxy({ ...baseInput, proxies: [disabled] });
    expect(outcome.selected).toBeNull();
    expect(outcome.unavailableReason).toBe('ALL_DISABLED');
  });

  it('reports NO_PROXIES for an empty catalogue', () => {
    const outcome = selectProxy({ ...baseInput, proxies: [] });
    expect(outcome.unavailableReason).toBe('NO_PROXIES');
  });
});
