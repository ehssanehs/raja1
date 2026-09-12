/**
 * Registry behaviour (spec § 20) and its security properties.
 */
import { describe, expect, it } from 'vitest';
import { createRegistry, ProviderRegistry } from '../registry';
import { MockProviderAdapter } from '../mock/provider';
import { TargetProviderAdapter } from '../providers/target-provider/adapter';
import type { ProviderAdapter } from '../types';

function adapterWith(code: string, overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  const base = new MockProviderAdapter(code);
  return Object.assign(Object.create(Object.getPrototypeOf(base)) as ProviderAdapter, base, overrides);
}

describe('registry', () => {
  it('registers, resolves and lists adapters', () => {
    const registry = createRegistry([new MockProviderAdapter('mock'), new TargetProviderAdapter('raja')]);
    expect(registry.codes()).toEqual(['mock', 'raja']);
    expect(registry.get('mock').code).toBe('mock');
    expect(registry.has('raja')).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  it('refuses duplicate registration instead of silently replacing adapters', () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProviderAdapter('mock'));
    expect(() => registry.register(new MockProviderAdapter('mock'))).toThrowError(/already registered/i);
  });

  it('allows an explicit override (used by tests and development hot-reload)', () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProviderAdapter('mock'));
    registry.override(new MockProviderAdapter('mock'));
    expect(registry.codes()).toEqual(['mock']);
  });

  it('throws NOT_FOUND for an unknown provider code', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('does-not-exist')).toThrowError(/unknown provider/i);
  });

  it('rejects adapters that declare inconsistent capabilities', () => {
    const registry = new ProviderRegistry();
    const greedy = adapterWith('greedy', {
      capabilities: {
        ...new MockProviderAdapter().capabilities,
        supportsAutoBooking: true,
        paymentsAreThirdParty: true,
      },
    });
    expect(() => registry.register(greedy)).toThrowError(/auto-booking while payments are third-party/i);
  });

  it('rejects an approved adapter that always requires a human challenge', () => {
    const registry = new ProviderRegistry();
    const contradiction = adapterWith('contradiction', {
      compliance: { status: 'APPROVED', notes: 'contradictory fixture' },
      capabilities: { ...new MockProviderAdapter().capabilities, requiresCaptcha: 'ALWAYS' },
    });
    expect(() => registry.register(contradiction)).toThrowError(/always presents a human challenge/i);
  });

  it('lists only search-capable providers for monitoring', () => {
    const registry = createRegistry([new MockProviderAdapter('mock'), new TargetProviderAdapter('raja')]);
    // The disabled provider is still listed by code, but its compliance status is what matters.
    expect(registry.searchable(true).map((adapter) => adapter.code)).toEqual(['mock', 'raja']);
    // An enabled-code filter is honoured (this is how `providers.enabled` is applied at runtime).
    expect(registry.searchable(true, ['mock']).map((adapter) => adapter.code)).toEqual(['mock']);
  });

  it('never registers a PROHIBITED provider as searchable', () => {
    const registry = new ProviderRegistry();
    const prohibited = adapterWith('prohibited', {
      compliance: { status: 'PROHIBITED', notes: 'banned provider fixture' },
    });
    registry.register(prohibited);
    expect(registry.searchable(false).map((adapter) => adapter.code)).toEqual([]);
  });

  it('clear() empties the registry (test isolation)', () => {
    const registry = createRegistry([new MockProviderAdapter('mock')]);
    registry.clear();
    expect(registry.codes()).toEqual([]);
  });
});
