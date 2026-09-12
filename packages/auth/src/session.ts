/**
 * Session lifecycle: issue, authenticate, rotate, revoke (TM-03 stolen refresh tokens).
 *
 * Properties the platform depends on:
 *  - access tokens are short-lived JWTs; refresh tokens are opaque, hashed at rest, single-use
 *  - every rotation keeps a `family_id`; replaying a rotated token revokes the whole family and
 *    raises a security event (the standard defence against silent token theft)
 *  - revocation is immediate and server-side, so "log out all devices" really means it
 *  - nothing here trusts the client: the session row is the source of truth
 */
import { AppError, isRole, unauthenticated, uuid, type Permission, type Principal, type Role } from '@raja/shared';
import type { DbClient } from '@raja/database';
import {
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  isWellFormedRefreshToken,
  verifyAccessToken,
  type AccessTokenIssueOptions,
} from './tokens';

export interface SessionConfig extends AccessTokenIssueOptions {
  refreshTtlSeconds: number;
}

export interface CreateSessionInput {
  userId: string;
  tenantId: string;
  role: Role;
  userAgent?: string;
  ipHash?: string;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface AuthenticatedSession {
  principal: Principal;
  sessionId: string;
  expiresAt: Date;
}

export interface SessionEvent {
  type: 'session.created' | 'session.rotated' | 'session.revoked' | 'session.reuse_detected';
  userId: string;
  tenantId: string;
  sessionId: string;
  reason?: string;
}

export interface SessionServiceDeps {
  db: DbClient;
  config: SessionConfig;
  now?: () => Date;
  onEvent?: (event: SessionEvent) => void;
}

interface SessionRow {
  [column: string]: unknown;
  id: string;
  user_id: string;
  tenant_id: string;
  family_id: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  revoked_reason: string | null;
}

export class SessionService {
  private readonly now: () => Date;

  /**
   * Token version. Bumping this value (via `invalidateIssuedTokens()`) makes every previously
   * issued access token fail verification, which is the cheap "log everyone out" switch used after
   * a role change or a suspected compromise.
   */
  private version = 0;

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Invalidate all access tokens issued before now (refresh tokens stay valid until rotated). */
  invalidateIssuedTokens(): number {
    this.version += 1;
    return this.version;
  }

  async create(input: CreateSessionInput): Promise<IssuedSession> {
    const sessionId = uuid();
    const familyId = uuid();
    const refresh = generateRefreshToken();
    const refreshExpiresAt = new Date(this.now().getTime() + this.deps.config.refreshTtlSeconds * 1000);

    await this.deps.db.query(
      `INSERT INTO sessions
         (id, user_id, tenant_id, refresh_token_hash, family_id, user_agent_hash, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        input.userId,
        input.tenantId,
        refresh.hash,
        familyId,
        input.userAgent ?? '',
        input.ipHash ?? '',
        refreshExpiresAt,
      ],
    );

    const accessToken = await issueAccessToken(
      { sub: input.userId, tid: input.tenantId, role: input.role, sid: sessionId, ver: this.version },
      this.deps.config,
    );

    this.deps.onEvent?.({
      type: 'session.created',
      userId: input.userId,
      tenantId: input.tenantId,
      sessionId,
    });

    return {
      sessionId,
      accessToken,
      refreshToken: refresh.token,
      accessExpiresAt: new Date(this.now().getTime() + this.deps.config.ttlSeconds * 1000),
      refreshExpiresAt,
    };
  }

  /** Verify an access token and load the live session + user behind it. */
  async authenticate(accessToken: string): Promise<AuthenticatedSession> {
    const claims = await verifyAccessToken(accessToken, this.deps.config);

    const sessions = await this.deps.db.query<SessionRow>(
      `SELECT id, user_id, tenant_id, family_id, expires_at, revoked_at, revoked_reason
         FROM sessions WHERE id = $1 AND tenant_id = $2`,
      [claims.sid, claims.tid],
    );
    const session = sessions[0];
    if (!session) throw unauthenticated('session not found');
    if (session.revoked_at) throw unauthenticated('session revoked');
    if (new Date(session.expires_at).getTime() <= this.now().getTime()) throw unauthenticated('session expired');

    const user = await this.loadUser(session.tenant_id, session.user_id);
    if (!user) throw unauthenticated('user not found');
    if (user.status !== 'ACTIVE') throw unauthenticated(`user not active (${user.status})`);
    if (claims.ver !== undefined && claims.ver !== this.version) {
      throw unauthenticated('access token has been invalidated');
    }

    return {
      principal: {
        userId: session.user_id,
        tenantId: session.tenant_id,
        role: user.role,
        grants: await this.loadGrants(session.user_id),
        isPlatformStaff: false,
      },
      sessionId: session.id,
      expiresAt: new Date(session.expires_at),
    };
  }

  /**
   * Exchange a refresh token for a new pair. The old token is revoked atomically; presenting an
   * already-rotated token revokes the entire family and reports a reuse event.
   */
  async rotate(refreshToken: string, context: { userAgent?: string; ipHash?: string } = {}): Promise<IssuedSession> {
    if (!isWellFormedRefreshToken(refreshToken)) throw unauthenticated('malformed refresh token');
    const hash = hashRefreshToken(refreshToken);

    const rows = await this.deps.db.query<SessionRow>(
      `SELECT id, user_id, tenant_id, family_id, expires_at, revoked_at, revoked_reason
         FROM sessions WHERE refresh_token_hash = $1`,
      [hash],
    );
    const session = rows[0];
    if (!session) throw unauthenticated('unknown refresh token');

    if (session.revoked_at) {
      await this.revokeFamily(session.family_id, session.user_id, session.tenant_id, 'reuse_detected');
      this.deps.onEvent?.({
        type: 'session.reuse_detected',
        userId: session.user_id,
        tenantId: session.tenant_id,
        sessionId: session.id,
      });
      throw new AppError('UNAUTHENTICATED', 'refresh token reuse detected; all sessions revoked', {
        userMessageKey: 'error.session_reuse',
      });
    }
    if (new Date(session.expires_at).getTime() <= this.now().getTime()) {
      throw unauthenticated('refresh token expired');
    }

    const user = await this.loadUser(session.tenant_id, session.user_id);
    if (!user || user.status !== 'ACTIVE') throw unauthenticated('user not active');

    const newSessionId = uuid();
    const refresh = generateRefreshToken();
    const refreshExpiresAt = new Date(this.now().getTime() + this.deps.config.refreshTtlSeconds * 1000);

    await this.deps.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions
           (id, user_id, tenant_id, refresh_token_hash, family_id, user_agent_hash, ip_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newSessionId,
          session.user_id,
          session.tenant_id,
          refresh.hash,
          session.family_id,
          context.userAgent ?? '',
          context.ipHash ?? '',
          refreshExpiresAt,
        ],
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $1
          WHERE id = $2 AND revoked_at IS NULL`,
        [newSessionId, session.id],
      );
    });

    const accessToken = await issueAccessToken(
      { sub: session.user_id, tid: session.tenant_id, role: user.role, sid: newSessionId, ver: this.version },
      this.deps.config,
    );

    this.deps.onEvent?.({
      type: 'session.rotated',
      userId: session.user_id,
      tenantId: session.tenant_id,
      sessionId: newSessionId,
    });

    return {
      sessionId: newSessionId,
      accessToken,
      refreshToken: refresh.token,
      accessExpiresAt: new Date(this.now().getTime() + this.deps.config.ttlSeconds * 1000),
      refreshExpiresAt,
    };
  }

  async revoke(sessionId: string, reason = 'user_logout'): Promise<void> {
    await this.deps.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }

  async revokeAllForUser(userId: string, reason = 'revoked_all'): Promise<number> {
    const rows = await this.deps.db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId, reason],
    );
    return rows.length;
  }

  private async revokeFamily(familyId: string, userId: string, tenantId: string, reason: string): Promise<void> {
    await this.deps.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
    this.deps.onEvent?.({
      type: 'session.revoked',
      userId,
      tenantId,
      sessionId: familyId,
      reason,
    });
  }

  private async loadUser(tenantId: string, userId: string): Promise<{ role: Role; status: string } | null> {
    const rows = await this.deps.db.query<{ role: string; status: string }>(
      `SELECT role, status FROM users WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId],
    );
    const row = rows[0];
    if (!row || !isRole(row.role)) return null;
    return { role: row.role, status: row.status };
  }

  private async loadGrants(userId: string): Promise<Permission[]> {
    const rows = await this.deps.db.query<{ permission: string }>(
      `SELECT permission FROM user_permission_grants
        WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    return rows.map((row) => row.permission as Permission);
  }
}
