/**
 * Integration test: sessions, refresh rotation and Telegram linking against a real PostgreSQL
 * engine (PGlite) with the production schema applied.
 *
 * Proves the properties the security review asks about (TM-03, TM-09):
 *  - a refresh token can be used exactly once; replaying it revokes the whole family
 *  - revocation is immediate for access tokens (the session row is checked on every call)
 *  - link challenges are single-use, expiring and bound to one Telegram account
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteClient, migrateUp, type DbClient } from '@raja/database';
import { SessionService } from '../src/session';
import { TelegramLinkService } from '../src/telegram-link';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';
const USER = randomUUID();
const OTHER_USER = randomUUID();

const sessionConfig = {
  secret: 'integration-test-access-secret-32-chars',
  issuer: 'raja1-integration',
  ttlSeconds: 900,
  refreshTtlSeconds: 86_400,
  clockToleranceSeconds: 0,
};

let db: DbClient;
let sessions: SessionService;
let telegram: TelegramLinkService;

beforeAll(async () => {
  db = await PGliteClient.create();
  await migrateUp(db, { skipLock: true });
  await db.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
    [TENANT, OTHER_TENANT],
  );
  await db.query(
    `INSERT INTO users (id, tenant_id, email, role, status, full_name)
     VALUES ($1, $2, 'user@example.test', 'USER', 'ACTIVE', 'Test User'),
            ($3, $4, 'other@example.test', 'USER', 'ACTIVE', 'Other User')`,
    [USER, TENANT, OTHER_USER, OTHER_TENANT],
  );
  sessions = new SessionService({ db, config: sessionConfig });
  telegram = new TelegramLinkService(db, { pepper: 'integration-pepper' });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('session lifecycle', () => {
  it('issues a working access token and resolves the principal', async () => {
    const issued = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    const authenticated = await sessions.authenticate(issued.accessToken);
    expect(authenticated.principal).toMatchObject({ userId: USER, tenantId: TENANT, role: 'USER' });
    expect(authenticated.sessionId).toBe(issued.sessionId);
  });

  it('rejects a malformed access token', async () => {
    await expect(sessions.authenticate('not-a-token')).rejects.toThrow(/invalid access token/i);
  });

  it('rotates the refresh token exactly once and revokes the family on replay', async () => {
    const issued = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    const rotated = await sessions.rotate(issued.refreshToken);
    expect(rotated.sessionId).not.toBe(issued.sessionId);

    // The new pair works.
    await expect(sessions.authenticate(rotated.accessToken)).resolves.toBeTruthy();

    // Replaying the old (already rotated) token is treated as theft.
    await expect(sessions.rotate(issued.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // …and the whole family is dead, including the token the attacker's victim was using.
    await expect(sessions.authenticate(rotated.accessToken)).rejects.toThrow(/revoked/i);
    await expect(sessions.rotate(rotated.refreshToken)).rejects.toThrow(/revoked|reuse/i);
  });

  it('makes revocation immediate', async () => {
    const issued = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    await sessions.revoke(issued.sessionId, 'user_logout');
    await expect(sessions.authenticate(issued.accessToken)).rejects.toThrow(/revoked/i);
  });

  it('revokes every session of a user at once', async () => {
    const first = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    const second = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    const revoked = await sessions.revokeAllForUser(USER, 'password_changed');
    expect(revoked).toBeGreaterThanOrEqual(2);
    await expect(sessions.authenticate(first.accessToken)).rejects.toThrow(/revoked/i);
    await expect(sessions.authenticate(second.accessToken)).rejects.toThrow(/revoked/i);
  });

  it('refuses sessions for users of another tenant', async () => {
    const issued = await sessions.create({ userId: OTHER_USER, tenantId: OTHER_TENANT, role: 'USER' });
    await expect(sessions.authenticate(issued.accessToken)).resolves.toBeTruthy();
    // A token whose tenant does not contain the session cannot be authenticated.
    const forged = await sessions.create({ userId: OTHER_USER, tenantId: OTHER_TENANT, role: 'USER' });
    await db.query('UPDATE sessions SET tenant_id = $1 WHERE id = $2', [TENANT, forged.sessionId]);
    await expect(sessions.authenticate(forged.accessToken)).rejects.toThrow(/session not found/i);
  });

  it('suspends authentication for non-active users', async () => {
    const issued = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    await db.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [USER]);
    await expect(sessions.authenticate(issued.accessToken)).rejects.toThrow(/not active/i);
    await db.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [USER]);
  });

  it('invalidates previously issued access tokens when the token version is bumped', async () => {
    const issued = await sessions.create({ userId: USER, tenantId: TENANT, role: 'USER' });
    await expect(sessions.authenticate(issued.accessToken)).resolves.toBeTruthy();
    sessions.invalidateIssuedTokens();
    await expect(sessions.authenticate(issued.accessToken)).rejects.toThrow(/invalidated/i);
  });
});

describe('telegram linking', () => {
  it('links an account through a single-use challenge', async () => {
    const telegramUserId = 123456789;
    const challenge = await telegram.createChallenge(USER, TENANT);
    expect(challenge.code).toMatch(/^[A-Z0-9]{8}$/);

    // The stored value is a hash, never the code itself.
    const stored = await db.query<{ code_hash: string }>(
      'SELECT code_hash FROM telegram_link_challenges WHERE user_id = $1',
      [USER],
    );
    expect(stored[0]?.code_hash).not.toContain(challenge.code);

    const linked = await telegram.consumeChallenge(challenge.code, telegramUserId, 'test_user');
    expect(linked).toMatchObject({ userId: USER, tenantId: TENANT, telegramUserId });

    // Single use.
    await expect(telegram.consumeChallenge(challenge.code, telegramUserId)).rejects.toThrow(/unknown or already used/i);

    const found = await telegram.findByTelegramUser(telegramUserId);
    expect(found?.userId).toBe(USER);
  });

  it('refuses to steal a link that belongs to another user', async () => {
    const telegramUserId = 987654321;
    const first = await telegram.createChallenge(USER, TENANT);
    await telegram.consumeChallenge(first.code, telegramUserId);

    const second = await telegram.createChallenge(OTHER_USER, OTHER_TENANT);
    await expect(telegram.consumeChallenge(second.code, telegramUserId)).rejects.toThrow(/already linked/i);
  });

  it('expires challenges and rejects malformed codes', async () => {
    const expired = await telegram.createChallenge(USER, TENANT);
    await db.query('UPDATE telegram_link_challenges SET expires_at = now() - interval \'1 minute\' WHERE code_hash IS NOT NULL');
    await expect(telegram.consumeChallenge(expired.code, 555000111)).rejects.toThrow(/expired|unknown/i);
    await expect(telegram.consumeChallenge('bad code!', 555000111)).rejects.toThrow(/malformed/i);
  });

  it('unlinks cleanly and allows re-linking afterwards', async () => {
    const telegramUserId = 222333444;
    const challenge = await telegram.createChallenge(USER, TENANT);
    await telegram.consumeChallenge(challenge.code, telegramUserId);
    await telegram.unlink(USER);
    expect(await telegram.findByTelegramUser(telegramUserId)).toBeNull();

    const again = await telegram.createChallenge(USER, TENANT);
    await telegram.consumeChallenge(again.code, telegramUserId);
    expect((await telegram.findByTelegramUser(telegramUserId))?.userId).toBe(USER);
  });
});
