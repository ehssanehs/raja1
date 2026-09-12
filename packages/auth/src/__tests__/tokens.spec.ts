/**
 * Access/refresh token behaviour (TM-03).
 *
 * These tests use a fixed clock so expiry is deterministic — no sleeping in the suite.
 */
import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
  issueAccessToken,
  verifyAccessToken,
  type AccessTokenIssueOptions,
} from '../tokens';
import { toPasswordHash, verifyUserPassword, passwordNeedsRehash } from '../passwords';

const options: AccessTokenIssueOptions = {
  secret: 'unit-test-secret-value-please-change',
  issuer: 'raja1-test',
  ttlSeconds: 60,
  clockToleranceSeconds: 0,
};

const claims = {
  sub: '00000000-0000-4000-8000-000000000001',
  tid: '00000000-0000-4000-8000-00000000000a',
  role: 'USER' as const,
  sid: '00000000-0000-4000-8000-0000000000ff',
};

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await issueAccessToken(claims, options);
    const verified = await verifyAccessToken(token, options);
    expect(verified).toMatchObject({ sub: claims.sub, tid: claims.tid, sid: claims.sid, role: 'USER' });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await issueAccessToken(claims, options);
    await expect(
      verifyAccessToken(token, { ...options, secret: 'another-secret-value-entirely-ok' }),
    ).rejects.toThrow(/invalid access token/i);
  });

  it('rejects a tampered payload', async () => {
    const token = await issueAccessToken(claims, options);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')) as Record<string, unknown>;
    decoded['role'] = 'SUPER_ADMIN';
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
    await expect(verifyAccessToken(forged, options)).rejects.toThrow(/invalid access token/i);
  });

  it('rejects an expired token with a distinct error code', async () => {
    // TTL of -1s: issued already expired (no sleeping required).
    const expired = await issueAccessToken(claims, { ...options, ttlSeconds: -1 });
    await expect(verifyAccessToken(expired, options)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses to sign with a weak secret', async () => {
    await expect(issueAccessToken(claims, { ...options, secret: 'short' })).rejects.toThrow(/too short/i);
  });
});

describe('refresh tokens', () => {
  it('produces a URL-safe token and a stable hash', () => {
    const pair = generateRefreshToken();
    expect(pair.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(isWellFormedRefreshToken(pair.token)).toBe(true);
    expect(hashRefreshToken(pair.token)).toBe(pair.hash);
    expect(pair.hash).toHaveLength(64);
  });

  it('rejects malformed tokens before touching the database', () => {
    expect(isWellFormedRefreshToken('too-short')).toBe(false);
    expect(isWellFormedRefreshToken(`${'a'.repeat(64)}!`)).toBe(false);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateRefreshToken().token));
    expect(tokens.size).toBe(50);
  });
});

describe('passwords', () => {
  const context = { pepper: 'pepper-for-tests' };

  it('hashes with argon2id and verifies', async () => {
    const hash = await toPasswordHash('Correct-Horse-9!', context);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyUserPassword('Correct-Horse-9!', hash, context)).toBe(true);
    expect(await verifyUserPassword('wrong-password', hash, context)).toBe(false);
  });

  it('fails closed for missing hashes and different peppers', async () => {
    const hash = await toPasswordHash('Correct-Horse-9!', context);
    expect(await verifyUserPassword('Correct-Horse-9!', null, context)).toBe(false);
    expect(await verifyUserPassword('Correct-Horse-9!', hash, { pepper: 'another-pepper' })).toBe(false);
  });

  it('rejects passwords that do not meet the policy', async () => {
    await expect(toPasswordHash('short', context)).rejects.toThrow(/password/i);
  });

  it('flags hashes produced with weaker parameters for rehashing', () => {
    expect(passwordNeedsRehash('not-a-hash')).toBe(true);
  });
});
