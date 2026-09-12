/**
 * Adapter registry (spec § 20).
 *
 * The registry is the only place that knows which adapters exist. Higher layers resolve an adapter
 * by the `provider_code` stored on the booking request, which keeps provider choice a data problem
 * (a row in `providers`) rather than a code problem.
 */
import { conflict, notFound } from '@raja/shared';
import type { ProviderAdapter } from './types';
import { assertComplianceConsistent } from './compliance';

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.code)) {
      throw conflict(`provider adapter ${adapter.code} is already registered`);
    }
    assertComplianceConsistent(adapter);
    this.adapters.set(adapter.code, adapter);
  }

  /** Replace an existing registration (used by tests and by hot-reload in development). */
  override(adapter: ProviderAdapter): void {
    assertComplianceConsistent(adapter);
    this.adapters.set(adapter.code, adapter);
  }

  has(code: string): boolean {
    return this.adapters.has(code);
  }

  get(code: string): ProviderAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) throw notFound(`unknown provider: ${code}`);
    return adapter;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  codes(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Adapters that may be used for read-only monitoring (search) right now. */
  searchable(dryRun: boolean, enabledCodes?: readonly string[]): ProviderAdapter[] {
    return this.list().filter((adapter) => {
      if (enabledCodes && !enabledCodes.includes(adapter.code)) return false;
      return adapter.compliance.status !== 'PROHIBITED';
    });
  }

  clear(): void {
    this.adapters.clear();
  }
}

/** Shared default registry; applications may create their own for isolated tests. */
export function createRegistry(adapters: readonly ProviderAdapter[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
