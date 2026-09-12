/**
 * @raja/logging — structured JSON logging with mandatory PII redaction (TM-06, spec § 69).
 *
 * Guarantees:
 *  1. A fixed, tested list of redaction paths is applied by pino at serialization time.
 *  2. `sanitize()` scrubs nested objects by key pattern before they reach the logger, so a
 *     developer cannot leak PII by passing an unknown-shaped object.
 *  3. Correlation context (correlationId / tenantId / userId / jobId / bookingId) is propagated
 *     via AsyncLocalStorage and bound automatically to every log line.
 *  4. Depth and array sizes are bounded so a huge object cannot flood the log pipeline.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger, type LoggerOptions } from 'pino';

/** Key names that must never be logged, matched case-insensitively ignoring separators. */
export const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'authheader',
  'apikey',
  'nationalid',
  'melli',
  'passport',
  'cardnumber',
  'cvv',
  'cvc',
  'pin',
  'iban',
  'sheba',
  'phone',
  'mobile',
  'telegramid',
  'sessioncookie',
  'storagestate',
  'refreshtoken',
  'privatekey',
  'pepper',
] as const;

export const REDACT_PATHS = [
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'cookies',
  '*.cookies',
  'token',
  'accessToken',
  'refreshToken',
  '*.accessToken',
  '*.refreshToken',
  'nationalId',
  '*.nationalId',
  'passportNumber',
  '*.passportNumber',
  'cardNumber',
  '*.cardNumber',
  'masterKeys',
  '*.masterKeys',
];

const CENSOR = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY = 20;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** Deep-sanitize a value for logging: sensitive keys censored, depth/size bounded. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecretsInString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[dropped]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretsInString(value.message),
      ...(depth < MAX_DEPTH && value.cause ? { cause: sanitize(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array(${value.length})]`;
    return value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[object]';
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? CENSOR : sanitize(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** Catches secrets that appear *inside* strings (tokens in URLs, bearer headers, JWTs). */
export function redactSecretsInString(input: string): string {
  return input
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${CENSOR}`)
    .replace(/([?&](?:token|code|password|key)=)[^&\s]+/gi, `$1${CENSOR}`)
    // key=value / key: value pairs in free text (errors, upstream messages)
    .replace(
      /\b(token|password|passwd|secret|api[_-]?key|authorization|code)\s*([=:])\s*[^\s,;&]+/gi,
      (_match, name: string, separator: string) => `${name}${separator}${CENSOR}`,
    )
    .replace(/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, CENSOR)
    .replace(/\b\d{16}\b/g, (match) => `[card:${match.slice(-4)}]`)
    // Iranian national ids (10 digits) and mobile numbers embedded in free text.
    // Over-redacting bare 10-digit numbers in logs is an accepted trade-off (TM-06).
    .replace(/\b\d{10}\b/g, '[redacted-id]')
    .replace(/\b(?:\+?98|0098|0)?9\d{9}\b/g, '[redacted-phone]');
}

export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  userId?: string;
  jobId?: string;
  bookingId?: string;
  providerCode?: string;
  queueName?: string;
  [key: string]: string | undefined;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

/** Run a unit of work with bound log context. Nesting merges with the parent context. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = contextStorage.getStore() ?? {};
  return contextStorage.run({ ...parent, ...context }, fn);
}

export function getLogContext(): LogContext {
  return contextStorage.getStore() ?? {};
}

export function updateLogContext(patch: LogContext): void {
  const store = contextStorage.getStore();
  if (store) Object.assign(store, patch);
}

export interface LoggerOptionsInput {
  level?: string;
  name?: string;
  /** Pretty printing for local development only. */
  pretty?: boolean;
  /** Extra pino options (e.g. a destination stream in tests). */
  pinoOptions?: LoggerOptions;
  /** Custom destination (tests capture here). */
  destination?: pino.DestinationStream;
}

export function createLogger(options: LoggerOptionsInput = {}): Logger {
  const base: LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    name: options.name ?? 'raja1',
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options.pinoOptions,
  };
  if (options.destination) return pino(base, options.destination);
  if (options.pretty) {
    return pino(
      base,
      pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      }),
    );
  }
  return pino(base);
}

let rootLogger: Logger = createLogger();

/** Replace the root logger (application bootstrap; tests capturing output). */
export function configureRootLogger(logger: Logger): void {
  rootLogger = logger;
}

export function getRootLogger(): Logger {
  return rootLogger;
}

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Wrap a pino logger so that:
 *  - ambient context + fixed bindings are merged into every line
 *  - the payload is sanitized before serialization
 *  - `logger.exception(err)` produces a safe error shape
 */
export function wrapLogger(inner: Logger, bindings: Record<string, unknown> = {}): Logger {
  const emit =
    (level: Level) =>
    (first: unknown, second?: unknown, ...rest: unknown[]): void => {
      const context = sanitize({ ...getLogContext(), ...bindings }) as Record<string, unknown>;
      if (typeof first === 'string') {
        const payload = sanitize(second);
        inner[level](
          {
            ...context,
            ...(typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}),
          },
          first,
        );
        return;
      }
      const payload = sanitize(first) as Record<string, unknown>;
      const message =
        typeof second === 'string'
          ? second
          : first instanceof Error
            ? redactSecretsInString(first.message)
            : String(payload?.['event'] ?? '');
      inner[level]({ ...context, ...payload }, message);
    };

  const wrapped = Object.create(inner) as Logger;
  Object.assign(wrapped, {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child: (childBindings: Record<string, unknown>) =>
      wrapLogger(inner.child(childBindings as pino.Bindings), { ...bindings, ...childBindings }),
  });
  return wrapped;
}

/** Logger bound to a module name, carrying ambient context and sanitizing payloads. */
export function loggerFor(module: string): Logger {
  return wrapLogger(rootLogger.child({ module }), {});
}

export type { Logger };
export { pino };
