/**
 * Config is a security boundary (TM-20, spec § 114): these tests prove the platform cannot be
 * started in an unsafe or ambiguous state.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, envSchema, loadConfig } from '../index';

const baseEnv = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('development defaults are fail-closed', () => {
  const config = loadConfig(baseEnv);

  it('defaults to dry-run, mock provider and test payments', () => {
    expect(config.runtime.dryRun).toBe(true);
    expect(config.runtime.mockProvider).toBe(true);
    expect(config.runtime.paymentMode).toBe('test');
    expect(config.runtime.autoBookingGlobal).toBe(false);
    expect(config.runtime.liveBookingArmed).toBe(false);
  });

  it('parses boolean-ish values', () => {
    expect(envSchema.parse({ DRY_RUN: 'true' }).DRY_RUN).toBe(true);
    expect(envSchema.parse({ DRY_RUN: 'false' }).DRY_RUN).toBe(false);
    expect(envSchema.parse({ DRY_RUN: '1' }).DRY_RUN).toBe(true);
    expect(envSchema.parse({ DRY_RUN: 'no' }).DRY_RUN).toBe(false);
  });

  it('applies the documented defaults used by the scheduler', () => {
    expect(config.scheduler.tickMs).toBe(1000);
    expect(config.provider.maxRequestsPerMinute).toBe(30);
    expect(config.provider.minIntervalSeconds).toBeGreaterThanOrEqual(20);
    expect(config.retention.diagnosticsDays).toBe(14);
  });
});

describe('unsafe configurations are rejected', () => {
  it('refuses DRY_RUN=false outside production', () => {
    expect(() => loadConfig({ ...baseEnv, DRY_RUN: 'false', I_UNDERSTAND_LIVE_BOOKING: 'true' })).toThrow(ConfigError);
  });

  it('refuses live payments in development', () => {
    expect(() => loadConfig({ ...baseEnv, PAYMENT_MODE: 'live' })).toThrow(/PAYMENT_MODE=live/);
  });

  it('refuses production without strong secrets, datastores and keys', () => {
    const error = (() => {
      try {
        loadConfig({ NODE_ENV: 'production' });
        return undefined;
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const issues = error!.issues.join('\n');
    expect(issues).toMatch(/JWT_ACCESS_SECRET/);
    expect(issues).toMatch(/DATABASE_URL/);
    expect(issues).toMatch(/REDIS_URL/);
    expect(issues).toMatch(/MASTER_KEYS/);
    expect(issues).toMatch(/LOOKUP_HASH_KEY/);
  });

  it('refuses production live booking without the explicit confirmation flag', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DRY_RUN: 'false',
      DATABASE_URL: 'postgres://user:pass@db:5432/raja1',
      REDIS_URL: 'redis://redis:6379',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      PASSWORD_PEPPER: 'c'.repeat(40),
      PAYMENT_WEBHOOK_SECRET: 'd'.repeat(40),
      MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') }),
      ACTIVE_KEY_ID: 'k1',
      LOOKUP_HASH_KEY: 'e'.repeat(40),
      PAYMENT_MODE: 'live',
    };
    expect(() => loadConfig(env)).toThrow(/I_UNDERSTAND_LIVE_BOOKING/);
    // ... and with the flag it becomes armed
    const armed = loadConfig({ ...env, I_UNDERSTAND_LIVE_BOOKING: 'true' });
    expect(armed.runtime.liveBookingArmed).toBe(true);
    expect(armed.runtime.dryRun).toBe(false);
  });

  it('validates key material strictly', () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      MASTER_KEYS: JSON.stringify({ k1: 'not-base64-key-material' }),
    };
    expect(() => loadConfig(env)).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...baseEnv, MASTER_KEYS: 'not-json' })).toThrow(/not valid JSON/);
  });

  it('rejects out-of-range numeric configuration', () => {
    expect(() => loadConfig({ ...baseEnv, API_PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, PROVIDER_MAX_REQUESTS_PER_MINUTE: '100000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, WORKER_CONCURRENCY: '0' })).toThrow(ConfigError);
  });
});

describe('redacted summary', () => {
  it('never exposes secrets', () => {
    const config = loadConfig({
      ...baseEnv,
      JWT_ACCESS_SECRET: 'super-secret-access-token-value',
      MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') }),
      ACTIVE_KEY_ID: 'k1',
      TELEGRAM_BOT_TOKEN: '123456:abcdef',
    });
    const summary = JSON.stringify(describeConfig(config));
    expect(summary).not.toContain('super-secret-access-token-value');
    expect(summary).not.toContain('123456:abcdef');
    expect(summary).not.toContain(Buffer.alloc(32, 7).toString('base64'));
    expect(summary).toContain('keyCount');
  });
});
