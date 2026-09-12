/**
 * @raja/crypto — password hashing, envelope encryption, key ring and lookup hashes.
 *
 * Threat model: TM-07 (provider credentials/sessions), TM-08 (wallet integrity is a DB concern),
 * TM-20 (secrets), and passenger PII at rest (TM-06).
 *
 * Envelope format (versioned so a KMS/HSM can be added later without a migration):
 *
 *     enc:v1:<keyId>:<iv-base64url>:<ciphertext-base64url>:<authTag-base64url>
 *
 * - AES-256-GCM, a fresh 96-bit IV per encryption, authentication tag verified on decrypt.
 * - The key id travels with the ciphertext, enabling key rotation: old keys stay usable for
 *   decryption while `activeKeyId` is used for new writes (see `rotateEnvelope`).
 * - Lookup hashes are HMAC-SHA256 with a *separate* key (`LOOKUP_HASH_KEY`) because they must be
 *   deterministic for equality search (e.g. "does this user already have this passenger?").
 *   They are never used as a substitute for encryption.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash, scryptSync } from 'node:crypto';
import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

export const ENVELOPE_PREFIX = 'enc';
export const ENVELOPE_VERSION = 'v1';
export const AES_KEY_BYTES = 32;
export const AES_IV_BYTES = 12;

export class CryptoError extends Error {
  constructor(message: string, readonly code: 'INVALID_ENVELOPE' | 'UNKNOWN_KEY' | 'DECRYPT_FAILED' | 'INVALID_KEY_MATERIAL' | 'HASH_FAILED') {
    super(message);
    this.name = 'CryptoError';
  }
}

export interface KeyRing {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** Build a key ring from base64-encoded 32-byte keys (`MASTER_KEYS` env JSON). */
export function createKeyRing(masterKeys: Record<string, string>, activeKeyId: string): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const [keyId, material] of Object.entries(masterKeys)) {
    const buffer = decodeKeyMaterial(material);
    keys.set(keyId, buffer);
  }
  if (keys.size === 0) {
    throw new CryptoError('key ring is empty: at least one master key is required', 'INVALID_KEY_MATERIAL');
  }
  if (!keys.has(activeKeyId)) {
    throw new CryptoError(`active key id "${activeKeyId}" is not present in the key ring`, 'UNKNOWN_KEY');
  }
  return Object.freeze({ activeKeyId, keys });
}

function decodeKeyMaterial(material: string): Buffer {
  const buffer = Buffer.from(material, 'base64');
  if (buffer.length !== AES_KEY_BYTES) {
    throw new CryptoError(
      `key material must decode to exactly ${AES_KEY_BYTES} bytes for AES-256, got ${buffer.length}`,
      'INVALID_KEY_MATERIAL',
    );
  }
  return buffer;
}

/** Generate base64 key material for setup/rotation scripts (`raja1 keys:generate`). */
export function generateKeyMaterial(): string {
  return randomBytes(AES_KEY_BYTES).toString('base64');
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function encryptString(plaintext: string, ring: KeyRing, keyId = ring.activeKeyId): string {
  const key = ring.keys.get(keyId);
  if (!key) throw new CryptoError(`unknown key id: ${keyId}`, 'UNKNOWN_KEY');
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_PREFIX, ENVELOPE_VERSION, keyId, b64url(iv), b64url(ciphertext), b64url(tag)].join(':');
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:`);
}

export function parseEnvelope(envelope: string): { keyId: string; iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const parts = envelope.split(':');
  if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX || parts[1] !== ENVELOPE_VERSION) {
    throw new CryptoError('malformed encryption envelope', 'INVALID_ENVELOPE');
  }
  const [, , keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string, string];
  return {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
  };
}

export function decryptString(envelope: string, ring: KeyRing): string {
  const { keyId, iv, ciphertext, tag } = parseEnvelope(envelope);
  const key = ring.keys.get(keyId);
  if (!key) throw new CryptoError(`unknown key id: ${keyId}`, 'UNKNOWN_KEY');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new CryptoError('failed to decrypt payload (tampered or wrong key)', 'DECRYPT_FAILED');
  }
}

export function encryptJson(value: unknown, ring: KeyRing, keyId?: string): string {
  return encryptString(JSON.stringify(value), ring, keyId);
}

export function decryptJson<T>(envelope: string, ring: KeyRing): T {
  return JSON.parse(decryptString(envelope, ring)) as T;
}

/** Re-encrypt with the active key (used by the rotation job). */
export function rotateEnvelope(envelope: string, ring: KeyRing): string {
  const { keyId } = parseEnvelope(envelope);
  if (keyId === ring.activeKeyId) return envelope;
  return encryptString(decryptString(envelope, ring), ring);
}

/** Deterministic, keyed hash for equality lookups (national id, phone, provider username). */
export function lookupHash(value: string, lookupKey: string, normalizer?: (input: string) => string): string {
  const normalized = (normalizer ?? defaultNormalize)(value);
  return createHmac('sha256', lookupKey).update(normalized).digest('hex');
}

function defaultNormalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').trim().toLowerCase();
}

/** Irreversible SHA-256 used for high-entropy secrets we must compare later (refresh tokens). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison for tokens, signatures and codes. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Compare against self to keep the timing profile stable, then fail.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export interface PasswordHashOptions {
  /** Memory cost in KiB. Default: 19 MiB (OWASP minimum for Argon2id). */
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

/**
 * Argon2id password hash. Returns the encoded string (`$argon2id$v=19$m=…`) which contains
 * salt and parameters, so no separate salt column is needed.
 */
export async function hashPassword(password: string, options: PasswordHashOptions = {}): Promise<string> {
  try {
    return await argonHash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: options.memoryCost ?? 19_456,
      timeCost: options.timeCost ?? 2,
      parallelism: options.parallelism ?? 1,
    });
  } catch (error) {
    throw new CryptoError(`password hashing failed: ${(error as Error).message}`, 'HASH_FAILED');
  }
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    // Malformed hash must never throw into the auth flow; it is simply a failed verification.
    return false;
  }
}

/** True when the stored hash uses parameters weaker than the current policy. */
export function needsRehash(hash: string, options: PasswordHashOptions = {}): boolean {
  const memory = options.memoryCost ?? 19_456;
  const time = options.timeCost ?? 2;
  const parallelism = options.parallelism ?? 1;
  const match = /\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!match) return true;
  const [, , storedMemory, storedTime, storedParallelism] = match;
  return (
    Number(storedMemory) < memory || Number(storedTime) < time || Number(storedParallelism) !== parallelism
  );
}

/**
 * Peppered scrypt fallback for environments where the native Argon2 binding is unavailable.
 * Documented for completeness; production uses Argon2id (ADR/security review).
 */
export function hashPasswordScryptFallback(password: string, pepper: string, salt = randomBytes(16)): string {
  const derived = scryptSync(`${password}${pepper}`, salt, 64, { N: 2 ** 15, r: 8, p: 1 });
  return `scrypt$N=32768,r=8,p=1$${b64url(salt)}$${b64url(derived)}`;
}

export function verifyPasswordScryptFallback(hash: string, password: string, pepper: string): boolean {
  const parts = hash.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2]!, 'base64url');
  const expected = Buffer.from(parts[3]!, 'base64url');
  const actual = scryptSync(`${password}${pepper}`, salt, expected.length, { N: 2 ** 15, r: 8, p: 1 });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
