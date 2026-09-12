import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  constantTimeEqual,
  createKeyRing,
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
  generateKeyMaterial,
  hashPassword,
  isEnvelope,
  lookupHash,
  needsRehash,
  parseEnvelope,
  rotateEnvelope,
  sha256Hex,
  verifyPassword,
} from '../index';

const keyA = generateKeyMaterial();
const keyB = generateKeyMaterial();
const ring = createKeyRing({ k1: keyA }, 'k1');
const rotatingRing = createKeyRing({ k1: keyA, k2: keyB }, 'k2');

describe('envelope encryption', () => {
  it('round-trips strings and objects', () => {
    const envelope = encryptString('national-id:0499370899', ring);
    expect(isEnvelope(envelope)).toBe(true);
    expect(envelope.startsWith('enc:v1:k1:')).toBe(true);
    expect(decryptString(envelope, ring)).toBe('national-id:0499370899');

    const payload = { nationalId: '0499370899', firstName: 'Sara' };
    expect(decryptJson<typeof payload>(encryptJson(payload, ring), ring)).toEqual(payload);
  });

  it('never produces the same ciphertext twice (fresh IV per encryption)', () => {
    const first = encryptString('same-plaintext', ring);
    const second = encryptString('same-plaintext', ring);
    expect(first).not.toBe(second);
    expect(decryptString(first, ring)).toBe(decryptString(second, ring));
  });

  it('rejects tampered ciphertext, IV and auth tag (GCM authentication)', () => {
    const envelope = encryptString('sensitive', ring);
    const parts = envelope.split(':');
    const flip = (value: string): string => {
      const buffer = Buffer.from(value, 'base64url');
      buffer[0] = buffer[0]! ^ 0xff;
      return buffer.toString('base64url');
    };
    const tamperedCiphertext = [...parts.slice(0, 4), flip(parts[4]!), parts[5]!].join(':');
    const tamperedTag = [...parts.slice(0, 5), flip(parts[5]!)].join(':');
    const tamperedIv = [...parts.slice(0, 3), flip(parts[3]!), parts[4]!, parts[5]!].join(':');
    expect(() => decryptString(tamperedCiphertext, ring)).toThrow(CryptoError);
    expect(() => decryptString(tamperedTag, ring)).toThrow(CryptoError);
    expect(() => decryptString(tamperedIv, ring)).toThrow(CryptoError);
  });

  it('rejects malformed envelopes and unknown keys', () => {
    expect(() => decryptString('plaintext', ring)).toThrow(/malformed/);
    expect(() => decryptString('enc:v2:k1:a:b:c', ring)).toThrow(/malformed/);
    const foreign = encryptString('x', createKeyRing({ other: generateKeyMaterial() }, 'other'));
    expect(() => decryptString(foreign, ring)).toThrow(/unknown key id/);
  });

  it('rejects key material of the wrong size', () => {
    expect(() => createKeyRing({ k1: Buffer.from('too-short').toString('base64') }, 'k1')).toThrow(CryptoError);
    expect(() => createKeyRing({}, 'k1')).toThrow(/empty/);
    expect(() => createKeyRing({ k1: keyA }, 'missing')).toThrow(/not present/);
  });

  it('rotates envelopes onto the active key without changing the plaintext', () => {
    const old = encryptString('rotate-me', createKeyRing({ k1: keyA }, 'k1'));
    const rotated = rotateEnvelope(old, rotatingRing);
    expect(parseEnvelope(rotated).keyId).toBe('k2');
    expect(decryptString(rotated, rotatingRing)).toBe('rotate-me');
    // rotating again is a no-op
    expect(rotateEnvelope(rotated, rotatingRing)).toBe(rotated);
  });
});

describe('lookup hashes', () => {
  it('is deterministic and keyed', () => {
    const a = lookupHash('0499370899', 'lookup-key');
    const b = lookupHash('0499370899', 'lookup-key');
    const other = lookupHash('0499370899', 'other-key');
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).toHaveLength(64);
  });

  it('normalizes whitespace and case so user input does not create duplicates', () => {
    expect(lookupHash(' Sara@Example.com ', 'k')).toBe(lookupHash('sara@example.com', 'k'));
  });

  it('never exposes the original value', () => {
    expect(lookupHash('0499370899', 'k')).not.toContain('0499370899');
  });

  it('hashes high-entropy secrets irreversibly with sha256', () => {
    expect(sha256Hex('token')).toHaveLength(64);
    expect(sha256Hex('token')).not.toContain('token');
  });
});

describe('password hashing (Argon2id)', () => {
  const password = 'Correct-Horse-Battery-42';

  it('hashes and verifies, and rejects wrong passwords', async () => {
    const hash = await hashPassword(password);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('salts each hash so equal passwords produce different hashes', async () => {
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(second, password)).toBe(true);
  });

  it('never throws on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', password)).toBe(false);
    expect(await verifyPassword('', password)).toBe(false);
  });

  it('detects hashes that must be upgraded after a policy change', async () => {
    const weak = await hashPassword(password, { memoryCost: 4096, timeCost: 1 });
    expect(needsRehash(weak)).toBe(true);
    const current = await hashPassword(password);
    expect(needsRehash(current)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('constant time comparison', () => {
  it('compares equal and unequal values correctly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
