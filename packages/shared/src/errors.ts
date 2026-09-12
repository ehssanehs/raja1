/**
 * Typed application errors.
 *
 * Principles:
 *  - every error carries a stable machine `code` (used by clients, metrics and tests)
 *  - `message` is safe for logs; `userMessageKey` is an i18n key, never a raw provider string
 *  - errors never embed secrets, cookies, tokens or PII (TM-06)
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYMENT_REQUIRED',
  'ENTITLEMENT_DENIED',
  'QUOTA_EXCEEDED',
  'CAPABILITY_UNSUPPORTED',
  'COMPLIANCE_BLOCKED',
  'DRY_RUN_BLOCKED',
  'MAINTENANCE_ACTIVE',
  'KILL_SWITCH_ACTIVE',
  'IDEMPOTENCY_REPLAY',
  'TENANT_SCOPE_VIOLATION',
  'DEPENDENCY_UNAVAILABLE',
  'PROVIDER_ERROR',
  'PROVIDER_THROTTLED',
  'HUMAN_VERIFICATION_REQUIRED',
  'PROXY_UNAVAILABLE',
  'PROXY_PROTOCOL_UNSUPPORTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYMENT_REQUIRED: 402,
  ENTITLEMENT_DENIED: 403,
  QUOTA_EXCEEDED: 429,
  CAPABILITY_UNSUPPORTED: 409,
  COMPLIANCE_BLOCKED: 451,
  DRY_RUN_BLOCKED: 409,
  MAINTENANCE_ACTIVE: 503,
  KILL_SWITCH_ACTIVE: 503,
  IDEMPOTENCY_REPLAY: 409,
  TENANT_SCOPE_VIOLATION: 500,
  DEPENDENCY_UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
  PROVIDER_THROTTLED: 503,
  HUMAN_VERIFICATION_REQUIRED: 409,
  PROXY_UNAVAILABLE: 503,
  PROXY_PROTOCOL_UNSUPPORTED: 422,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  /** i18n key rendered to the end user. */
  userMessageKey?: string;
  /** Structured, non-sensitive context for logs/metrics. */
  details?: Record<string, unknown>;
  /** Root cause (kept out of HTTP responses). */
  cause?: unknown;
  /** Retry hint in seconds (sent as `Retry-After` where applicable). */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly userMessageKey: string;
  readonly details: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
  readonly isOperational = true;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = DEFAULT_STATUS[code];
    this.userMessageKey = options.userMessageKey ?? `error.${code.toLowerCase()}`;
    this.details = options.details ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Serialized form for HTTP responses — never includes `details` or `cause`. */
  toPublicJson(): { error: { code: ErrorCode; messageKey: string; retryAfterSeconds?: number } } {
    return {
      error: {
        code: this.code,
        messageKey: this.userMessageKey,
        ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      },
    };
  }
}

export const validationError = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('VALIDATION_FAILED', message, { details, userMessageKey: 'error.validation_failed' });

export const unauthenticated = (message = 'authentication required'): AppError =>
  new AppError('UNAUTHENTICATED', message, { userMessageKey: 'error.unauthenticated' });

export const forbidden = (message = 'permission denied', details?: Record<string, unknown>): AppError =>
  new AppError('FORBIDDEN', message, { details, userMessageKey: 'error.forbidden' });

export const notFound = (resource: string, id?: string): AppError =>
  new AppError('NOT_FOUND', `${resource} not found`, {
    details: id ? { resource, id } : { resource },
    userMessageKey: 'error.not_found',
  });

export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('CONFLICT', message, { details, userMessageKey: 'error.conflict' });

export const rateLimited = (retryAfterSeconds: number, details?: Record<string, unknown>): AppError =>
  new AppError('RATE_LIMITED', 'rate limit exceeded', {
    details,
    retryAfterSeconds,
    userMessageKey: 'error.rate_limited',
  });

export const entitlementDenied = (feature: string, planCode?: string): AppError =>
  new AppError('ENTITLEMENT_DENIED', `entitlement denied: ${feature}`, {
    details: { feature, planCode },
    userMessageKey: 'error.entitlement_denied',
  });

export const quotaExceeded = (meter: string, limit: number, used: number): AppError =>
  new AppError('QUOTA_EXCEEDED', `quota exceeded for ${meter}`, {
    details: { meter, limit, used },
    userMessageKey: 'error.quota_exceeded',
  });

export const capabilityUnsupported = (capability: string, provider: string): AppError =>
  new AppError('CAPABILITY_UNSUPPORTED', `provider ${provider} does not support ${capability}`, {
    details: { capability, provider },
    userMessageKey: 'error.capability_unsupported',
  });

export const complianceBlocked = (provider: string, reason: string): AppError =>
  new AppError('COMPLIANCE_BLOCKED', `provider ${provider} is not approved for this action: ${reason}`, {
    details: { provider, reason },
    userMessageKey: 'error.compliance_blocked',
  });

export const dryRunBlocked = (action: string): AppError =>
  new AppError('DRY_RUN_BLOCKED', `dry-run mode blocked irreversible action: ${action}`, {
    details: { action },
    userMessageKey: 'error.dry_run_blocked',
  });

export const maintenanceActive = (mode: string, scope?: string): AppError =>
  new AppError('MAINTENANCE_ACTIVE', `maintenance mode ${mode} is active`, {
    details: { mode, scope },
    userMessageKey: 'error.maintenance_active',
  });

export const killSwitchActive = (): AppError =>
  new AppError('KILL_SWITCH_ACTIVE', 'the global booking kill switch is active', {
    userMessageKey: 'error.kill_switch_active',
  });

export const idempotencyReplay = (key: string, details?: Record<string, unknown>): AppError =>
  new AppError('IDEMPOTENCY_REPLAY', 'request was already processed', {
    details: { key, ...details },
    userMessageKey: 'error.idempotency_replay',
  });

/** Raised when a tenant-scoped query is attempted without (or with a wrong) tenant scope. */
export const tenantScopeViolation = (details: Record<string, unknown>): AppError =>
  new AppError('TENANT_SCOPE_VIOLATION', 'tenant scope violation', {
    details,
    userMessageKey: 'error.internal',
  });

export const dependencyUnavailable = (dependency: string, cause?: unknown): AppError =>
  new AppError('DEPENDENCY_UNAVAILABLE', `dependency unavailable: ${dependency}`, {
    details: { dependency },
    cause,
    userMessageKey: 'error.dependency_unavailable',
  });

export const providerError = (provider: string, message: string, details?: Record<string, unknown>): AppError =>
  new AppError('PROVIDER_ERROR', `provider ${provider}: ${message}`, {
    details: { provider, ...details },
    userMessageKey: 'error.provider_error',
  });

export const providerThrottled = (provider: string, retryAfterSeconds: number): AppError =>
  new AppError('PROVIDER_THROTTLED', `provider ${provider} throttled the request`, {
    details: { provider },
    retryAfterSeconds,
    userMessageKey: 'error.provider_throttled',
  });

export const humanVerificationRequired = (provider: string): AppError =>
  new AppError('HUMAN_VERIFICATION_REQUIRED', `provider ${provider} requires human verification`, {
    details: { provider },
    userMessageKey: 'error.human_verification_required',
  });

export const internalError = (message: string, cause?: unknown): AppError =>
  new AppError('INTERNAL_ERROR', message, { cause, userMessageKey: 'error.internal' });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalize any thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown, fallbackMessage = 'unexpected error'): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) return internalError(`${fallbackMessage}: ${error.name}`, error);
  return internalError(fallbackMessage, error);
}
