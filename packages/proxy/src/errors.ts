/**
 * Typed errors for the egress proxy pool. Codes are stable tokens used by clients and tests.
 */
import { AppError } from '@raja/shared';
import type { ProxyUnavailableReason } from './types';

export type ProxyErrorCode = 'PROXY_UNAVAILABLE' | 'PROXY_PROTOCOL_UNSUPPORTED';

export class ProxyError extends AppError {
  constructor(code: ProxyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, { details });
    this.name = 'ProxyError';
  }
}

/** Thrown when the pool cannot provide an egress route (fail-closed in REQUIRED mode). */
export class ProxyUnavailableError extends ProxyError {
  constructor(readonly reason: ProxyUnavailableReason, message?: string) {
    super('PROXY_UNAVAILABLE', message ?? `no egress proxy available: ${reason}`, { reason });
    this.name = 'ProxyUnavailableError';
  }
}

/** SOCKS5 entries are catalogued for later use but this runtime ships HTTP/HTTPS transports only. */
export class ProxyProtocolUnsupportedError extends ProxyError {
  constructor(protocol: string) {
    super(
      'PROXY_PROTOCOL_UNSUPPORTED',
      `proxy protocol ${protocol} is not supported by this runtime (use HTTP/HTTPS)`,
      { protocol },
    );
    this.name = 'ProxyProtocolUnsupportedError';
  }
}
