/**
 * @raja/provider-sdk — the provider abstraction.
 *
 * Everything provider-specific lives behind `ProviderAdapter`. This package deliberately depends
 * only on `@raja/shared` (plus an optional Playwright peer for browser-based adapters) so the
 * booking domain has no compile-time relationship with any provider implementation.
 */
export * from './capabilities';
export * from './compliance';
export * from './normalize';
export * from './redaction';
export * from './registry';
export * from './types';
export * from './mock/provider';
export * from './providers/target-provider/adapter';
