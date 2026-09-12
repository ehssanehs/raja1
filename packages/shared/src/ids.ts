/**
 * Identifier helpers.
 *
 * Entity ids are UUID v4 (random, non-sequential: no enumeration signal, TM-01) with an
 * optional human-readable prefix kept *outside* the database value (`usr_<uuid>`) so logs and
 * support conversations are easier to follow without leaking ordering information.
 */

import { randomBytes, randomUUID } from 'node:crypto';

export const ID_PREFIXES = {
  tenant: 'tnt',
  user: 'usr',
  session: 'ses',
  passenger: 'psg',
  bookingRequest: 'bkr',
  monitor: 'mon',
  attempt: 'att',
  result: 'res',
  reservation: 'rsv',
  wallet: 'wal',
  transaction: 'txn',
  invoice: 'inv',
  payment: 'pay',
  subscription: 'sub',
  coupon: 'cpn',
  referral: 'ref',
  notification: 'ntf',
  audit: 'aud',
  providerAccount: 'pac',
  providerSession: 'psn',
  proxy: 'prx',
  searchJob: 'job',
  releaseWindow: 'rls',
  supportTicket: 'tkt',
  fraudSignal: 'fsg',
  correlation: 'cor',
  idempotency: 'idm',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export function uuid(): string {
  return randomUUID();
}

/** Prefixed id for logs/UI, e.g. `usr_3f9c…`. */
export function prefixedId(prefix: IdPrefix, id: string = randomUUID()): string {
  return `${prefix}_${id}`;
}

/** Suffix-safe random token (base64url), used for opaque tokens and codes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Numeric code of a given length (Telegram linking challenges, OTP-style flows). */
export function randomNumericCode(length = 6): string {
  const digits = '0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += digits[bytes[i]! % 10];
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Accepts `usr_<uuid>` or a bare uuid. */
export function normalizeId(value: string): string {
  const separator = value.indexOf('_');
  return separator > 0 ? value.slice(separator + 1) : value;
}

export function assertUuid(value: unknown, label = 'id'): asserts value is string {
  if (!isUuid(value)) throw new TypeError(`invalid ${label}: expected a UUID`);
}

/**
 * Human-facing, sortable, per-tenant sequence-friendly reference (invoices, tickets).
 * Format: `PREFIX-YYYYMM-XXXXXX` where X is zero-padded and derived from a caller-supplied
 * counter — the counter is authoritative in the database, never generated client-side.
 */
export function formatSequenceReference(prefix: string, date: Date, counter: number): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${prefix}-${year}${month}-${String(counter).padStart(6, '0')}`;
}
