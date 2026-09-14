/**
 * @raja/config — validated, fail-closed configuration (TM-20, spec § 114).
 *
 * Design rules:
 *  - the process refuses to start on invalid configuration (no silent defaults for critical values)
 *  - development defaults are *safe*: DRY_RUN on, mock provider, payment mode test
 *  - producing a live-booking configuration requires several explicit, consistent signals and is
 *    rejected outside production
 *  - `describe()` returns a loggable summary with every secret redacted
 */
import { z } from 'zod';
import { EGRESS_MODES, LOCALES, MAINTENANCE_MODES } from '@raja/shared';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => value === true || value === 'true' || value === '1' || value === 'yes');

const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('raja1'),
  APP_TIMEZONE: z.string().default('Asia/Tehran'),
  DEFAULT_LOCALE: z.enum(LOCALES).default('fa'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ---- HTTP ----
  API_PORT: port.default(3001),
  API_BASE_PATH: z.string().default('/api/v1'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // ---- datastores ----
  DATABASE_URL: z.string().default(''),
  DATABASE_SSL: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().default(''),

  // ---- safety switches (spec § 44/114) ----
  DRY_RUN: booleanish.default(true),
  MOCK_PROVIDER: booleanish.default(true),
  PAYMENT_MODE: z.enum(['test', 'live']).default('test'),
  /** Admin kill switch default; runtime value lives in the database and can only disable. */
  AUTO_BOOKING_GLOBAL: booleanish.default(false),
  /** Extra, explicit confirmation that must be present for live booking in production. */
  I_UNDERSTAND_LIVE_BOOKING: booleanish.default(false),

  // ---- auth ----
  JWT_ACCESS_SECRET: z.string().default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().default('dev-refresh-secret-change-me'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(300).default(60 * 60 * 24 * 30),
  JWT_ISSUER: z.string().default('raja1'),
  PASSWORD_PEPPER: z.string().default('dev-pepper-change-me'),

  // ---- encryption key ring: JSON { keyId: base64(32 bytes) } ----
  MASTER_KEYS: z.string().default(''),
  ACTIVE_KEY_ID: z.string().default('k1'),
  /** Key used for deterministic lookup hashes (national id dedup). */
  LOOKUP_HASH_KEY: z.string().default(''),

  // ---- telegram ----
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),

  // ---- payments ----
  PAYMENT_PROVIDER: z.enum(['test', 'manual']).default('test'),
  PAYMENT_WEBHOOK_SECRET: z.string().default('dev-webhook-secret-change-me'),

  // ---- provider / scheduling ----
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  PROVIDER_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(20).default(20),
  PROVIDER_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(1000),
  SCHEDULER_LEASE_SECONDS: z.coerce.number().int().min(5).default(30),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(4),
  BROWSER_POOL_SIZE: z.coerce.number().int().min(0).max(50).default(2),
  CIRCUIT_BREAKER_FAILURE_RATIO: z.coerce.number().min(0.05).max(0.95).default(0.4),
  CIRCUIT_BREAKER_MIN_SAMPLES: z.coerce.number().int().min(5).default(20),

  // ---- egress proxy pool (docs/proxy-pool.md; fail-closed: OFF by default) ----
  EGRESS_MODE: z.enum(EGRESS_MODES).default('OFF'),
  PROXY_MIN_HEALTH_SCORE: z.coerce.number().int().min(0).max(100).default(0),
  PROXY_PROBE_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  PROXY_LEASE_SECONDS: z.coerce.number().int().min(30).max(1800).default(600),

  // ---- mail / sms (optional) ----
  SMTP_URL: z.string().default(''),
  SMS_API_KEY: z.string().default(''),

  // ---- operations ----
  MAINTENANCE_MODE: z.enum(MAINTENANCE_MODES).default('NONE'),
  METRICS_ENABLED: booleanish.default(true),
  /** Retention defaults (days) — enforced by the maintenance queue. */
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(30).default(730),
  RETENTION_DIAGNOSTICS_DAYS: z.coerce.number().int().min(1).default(14),
  RETENTION_SEARCH_JOBS_DAYS: z.coerce.number().int().min(1).default(30),

  // ---- support/external (optional integrations) ----
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  /** OpenAPI docs are exposed only outside production unless explicitly enabled. */
  EXPOSE_API_DOCS: booleanish.default(true),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly appName: string;
  readonly providerTimezone: string;
  readonly defaultLocale: string;
  readonly logLevel: RawEnv['LOG_LEVEL'];
  readonly http: {
    apiPort: number;
    apiBasePath: string;
    apiPublicUrl: string;
    webPublicUrl: string;
    corsOrigins: string[];
    exposeApiDocs: boolean;
  };
  readonly db: { url: string; ssl: boolean; poolMax: number };
  readonly redis: { url: string };
  readonly runtime: {
    dryRun: boolean;
    mockProvider: boolean;
    paymentMode: 'test' | 'live';
    autoBookingGlobal: boolean;
    liveBookingArmed: boolean;
  };
  readonly auth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    issuer: string;
    passwordPepper: string;
  };
  readonly crypto: { masterKeys: Record<string, string>; activeKeyId: string; lookupHashKey: string };
  readonly telegram: { botToken: string; botUsername: string; webhookSecret: string };
  readonly payments: { provider: 'test' | 'manual'; webhookSecret: string };
  readonly provider: {
    timeoutMs: number;
    minIntervalSeconds: number;
    maxRequestsPerMinute: number;
    circuitBreakerFailureRatio: number;
    circuitBreakerMinSamples: number;
  };
  readonly scheduler: { tickMs: number; leaseSeconds: number };
  readonly worker: { concurrency: number; browserPoolSize: number };
  readonly proxy: {
    egressMode: (typeof EGRESS_MODES)[number];
    minHealthScore: number;
    probeIntervalSeconds: number;
    leaseSeconds: number;
  };
  readonly retention: { auditDays: number; diagnosticsDays: number; searchJobsDays: number };
  readonly integrations: { smtpUrl: string; smsApiKey: string; supportEmail: string };
  readonly metricsEnabled: boolean;
  readonly maintenanceMode: (typeof MAINTENANCE_MODES)[number];
}

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}

const INSECURE_DEFAULT_SECRETS = new Set([
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'dev-pepper-change-me',
  'dev-webhook-secret-change-me',
  'secret',
  'changeme',
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError('invalid environment configuration', issues);
  }
  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';
  const problems: string[] = [];

  const masterKeys = parseMasterKeys(raw.MASTER_KEYS, problems);
  if (isProduction) {
    for (const [label, value] of Object.entries({
      JWT_ACCESS_SECRET: raw.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: raw.JWT_REFRESH_SECRET,
      PASSWORD_PEPPER: raw.PASSWORD_PEPPER,
      PAYMENT_WEBHOOK_SECRET: raw.PAYMENT_WEBHOOK_SECRET,
    })) {
      if (INSECURE_DEFAULT_SECRETS.has(value) || value.length < 24) {
        problems.push(`${label} must be set to a strong (>=24 char) non-default value in production`);
      }
    }
    if (!raw.DATABASE_URL) problems.push('DATABASE_URL is required in production');
    if (!raw.REDIS_URL) problems.push('REDIS_URL is required in production');
    if (Object.keys(masterKeys).length === 0) problems.push('MASTER_KEYS is required in production (encryption key ring)');
    if (!raw.LOOKUP_HASH_KEY) problems.push('LOOKUP_HASH_KEY is required in production (deterministic lookup hashes)');
    if (!raw.TELEGRAM_BOT_TOKEN && raw.TELEGRAM_WEBHOOK_SECRET) {
      problems.push('TELEGRAM_BOT_TOKEN is required when a webhook secret is configured');
    }
  }

  // Fail-closed live-booking guard (three-signal rule, ADR-0005 / spec § 44, § 114):
  // live booking requires production, explicitly *not* dry-run, and a deliberate confirmation
  // flag. Any single-signal misconfiguration keeps the platform in dry-run.
  const liveBookingArmed =
    isProduction && raw.DRY_RUN === false && raw.I_UNDERSTAND_LIVE_BOOKING === true && raw.PAYMENT_MODE === 'live';
  if (raw.DRY_RUN === false && !isProduction) {
    problems.push('DRY_RUN=false is only permitted when NODE_ENV=production (development must stay in dry-run)');
  }
  if (raw.DRY_RUN === false && raw.I_UNDERSTAND_LIVE_BOOKING !== true) {
    problems.push('DRY_RUN=false requires I_UNDERSTAND_LIVE_BOOKING=true as an explicit confirmation');
  }
  if (raw.PAYMENT_MODE === 'live' && !liveBookingArmed) {
    problems.push('PAYMENT_MODE=live requires production + DRY_RUN=false + I_UNDERSTAND_LIVE_BOOKING=true');
  }
  if (!isProduction && raw.PAYMENT_MODE === 'live') {
    problems.push('PAYMENT_MODE=live is not permitted outside production');
  }

  if (problems.length > 0) {
    // The message lists every problem so operators can fix them in one pass; the details array
    // stays structured for tests and the /health/config diagnostic endpoint.
    throw new ConfigError(
      `refusing to start with unsafe configuration: ${problems.join('; ')}`,
      problems,
    );
  }

  return Object.freeze({
    env: raw.NODE_ENV,
    appName: raw.APP_NAME,
    providerTimezone: raw.APP_TIMEZONE,
    defaultLocale: raw.DEFAULT_LOCALE,
    logLevel: raw.LOG_LEVEL,
    http: Object.freeze({
      apiPort: raw.API_PORT,
      apiBasePath: raw.API_BASE_PATH,
      apiPublicUrl: raw.API_PUBLIC_URL,
      webPublicUrl: raw.WEB_PUBLIC_URL,
      corsOrigins: raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
      exposeApiDocs: raw.EXPOSE_API_DOCS && raw.NODE_ENV !== 'production',
    }),
    db: Object.freeze({ url: raw.DATABASE_URL, ssl: raw.DATABASE_SSL, poolMax: raw.DATABASE_POOL_MAX }),
    redis: Object.freeze({ url: raw.REDIS_URL }),
    runtime: Object.freeze({
      dryRun: raw.DRY_RUN,
      mockProvider: raw.MOCK_PROVIDER,
      paymentMode: raw.PAYMENT_MODE,
      autoBookingGlobal: raw.AUTO_BOOKING_GLOBAL,
      liveBookingArmed,
    }),
    auth: Object.freeze({
      accessSecret: raw.JWT_ACCESS_SECRET,
      refreshSecret: raw.JWT_REFRESH_SECRET,
      accessTtlSeconds: raw.JWT_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: raw.JWT_REFRESH_TTL_SECONDS,
      issuer: raw.JWT_ISSUER,
      passwordPepper: raw.PASSWORD_PEPPER,
    }),
    crypto: Object.freeze({
      masterKeys,
      activeKeyId: raw.ACTIVE_KEY_ID,
      lookupHashKey: raw.LOOKUP_HASH_KEY || raw.JWT_REFRESH_SECRET,
    }),
    telegram: Object.freeze({
      botToken: raw.TELEGRAM_BOT_TOKEN,
      botUsername: raw.TELEGRAM_BOT_USERNAME,
      webhookSecret: raw.TELEGRAM_WEBHOOK_SECRET,
    }),
    payments: Object.freeze({ provider: raw.PAYMENT_PROVIDER, webhookSecret: raw.PAYMENT_WEBHOOK_SECRET }),
    provider: Object.freeze({
      timeoutMs: raw.PROVIDER_TIMEOUT_MS,
      minIntervalSeconds: raw.PROVIDER_MIN_INTERVAL_SECONDS,
      maxRequestsPerMinute: raw.PROVIDER_MAX_REQUESTS_PER_MINUTE,
      circuitBreakerFailureRatio: raw.CIRCUIT_BREAKER_FAILURE_RATIO,
      circuitBreakerMinSamples: raw.CIRCUIT_BREAKER_MIN_SAMPLES,
    }),
    scheduler: Object.freeze({ tickMs: raw.SCHEDULER_TICK_MS, leaseSeconds: raw.SCHEDULER_LEASE_SECONDS }),
    worker: Object.freeze({ concurrency: raw.WORKER_CONCURRENCY, browserPoolSize: raw.BROWSER_POOL_SIZE }),
    proxy: Object.freeze({
      egressMode: raw.EGRESS_MODE,
      minHealthScore: raw.PROXY_MIN_HEALTH_SCORE,
      probeIntervalSeconds: raw.PROXY_PROBE_INTERVAL_SECONDS,
      leaseSeconds: raw.PROXY_LEASE_SECONDS,
    }),
    retention: Object.freeze({
      auditDays: raw.RETENTION_AUDIT_DAYS,
      diagnosticsDays: raw.RETENTION_DIAGNOSTICS_DAYS,
      searchJobsDays: raw.RETENTION_SEARCH_JOBS_DAYS,
    }),
    integrations: Object.freeze({
      smtpUrl: raw.SMTP_URL,
      smsApiKey: raw.SMS_API_KEY,
      supportEmail: raw.SUPPORT_EMAIL,
    }),
    metricsEnabled: raw.METRICS_ENABLED,
    maintenanceMode: raw.MAINTENANCE_MODE,
  });
}

function parseMasterKeys(value: string, problems: string[]): Record<string, string> {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push('MASTER_KEYS must be a JSON object of { keyId: base64Key }');
      return {};
    }
    const result: Record<string, string> = {};
    for (const [keyId, material] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof material !== 'string') {
        problems.push(`MASTER_KEYS.${keyId} must be a base64 string`);
        continue;
      }
      const bytes = Buffer.from(material, 'base64');
      if (bytes.length !== 32) {
        problems.push(`MASTER_KEYS.${keyId} must decode to exactly 32 bytes (AES-256)`);
        continue;
      }
      result[keyId] = material;
    }
    return result;
  } catch {
    problems.push('MASTER_KEYS is not valid JSON');
    return {};
  }
}

/** Loggable summary — never contains secret material. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    appName: config.appName,
    providerTimezone: config.providerTimezone,
    runtime: {
      dryRun: config.runtime.dryRun,
      mockProvider: config.runtime.mockProvider,
      paymentMode: config.runtime.paymentMode,
      autoBookingGlobal: config.runtime.autoBookingGlobal,
      liveBookingArmed: config.runtime.liveBookingArmed,
    },
    http: { apiPort: config.http.apiPort, apiBasePath: config.http.apiBasePath, exposeApiDocs: config.http.exposeApiDocs },
    db: { configured: Boolean(config.db.url), ssl: config.db.ssl, poolMax: config.db.poolMax },
    redis: { configured: Boolean(config.redis.url) },
    crypto: { activeKeyId: config.crypto.activeKeyId, keyCount: Object.keys(config.crypto.masterKeys).length },
    telegram: { configured: Boolean(config.telegram.botToken) },
    provider: config.provider,
    scheduler: config.scheduler,
    worker: config.worker,
    proxy: config.proxy,
    metricsEnabled: config.metricsEnabled,
    maintenanceMode: config.maintenanceMode,
  };
}

let cached: AppConfig | undefined;

/** Load once per process (throws ConfigError on invalid/unsafe configuration). */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!cached) cached = loadConfig(env);
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
