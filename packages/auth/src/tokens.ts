/**
 * Access tokens (short-lived, signed) and refresh tokens (opaque, stored hashed, rotated).
 *
 * Why not a refresh JWT: an opaque refresh token can be revoked server-side and its reuse can be
 * *detected* (TM-03). Access tokens stay stateless and short-lived so the hot path needs no
 * database round-trip; the session check happens whenever a token is close to expiry and on every
 * privileged operation.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { AppError, isRole, randomToken, unauthenticated, type Role } from '@raja/shared';
import { sha256Hex } from '@raja/crypto';

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** tenant id */
  tid: string;
  /** role at issue time */
  role: Role;
  /** session id (so the API can check revocation) */
  sid: string;
  /** token version, allows invalidating tokens by bumping the user's counter */
  ver?: number;
}

export interface AccessTokenIssueOptions {
  secret: string;
  issuer: string;
  ttlSeconds: number;
  /** Extra clock skew tolerance in seconds when verifying (default 5). */
  clockToleranceSeconds?: number;
}

function key(secret: string): Uint8Array {
  if (secret.length < 16) {
    throw new AppError('INTERNAL_ERROR', 'access-token secret is too short to sign tokens', {
      userMessageKey: 'error.internal',
    });
  }
  return new TextEncoder().encode(secret);
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  options: AccessTokenIssueOptions,
): Promise<string> {
  return new SignJWT({
    tid: claims.tid,
    role: claims.role,
    sid: claims.sid,
    ...(claims.ver === undefined ? {} : { ver: claims.ver }),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(options.issuer)
    .setAudience('raja1-api')
    .setIssuedAt()
    .setJti(randomToken(12))
    .setExpirationTime(`${options.ttlSeconds}s`)
    .sign(key(options.secret));
}

export async function verifyAccessToken(
  token: string,
  options: AccessTokenIssueOptions,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(options.secret), {
      issuer: options.issuer,
      audience: 'raja1-api',
      clockTolerance: options.clockToleranceSeconds ?? 5,
    });
    const role = payload['role'];
    if (
      typeof payload.sub !== 'string' ||
      typeof payload['tid'] !== 'string' ||
      typeof payload['sid'] !== 'string' ||
      !isRole(role)
    ) {
      throw unauthenticated('malformed access token');
    }
    return {
      sub: payload.sub,
      tid: payload['tid'],
      role,
      sid: payload['sid'],
      ...(typeof payload['ver'] === 'number' ? { ver: payload['ver'] } : {}),
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError('UNAUTHENTICATED', 'access token expired', {
        userMessageKey: 'error.session_expired',
      });
    }
    if (error instanceof AppError) throw error;
    throw unauthenticated('invalid access token');
  }
}

// --------------------------------------------------------------- refresh tokens --

export interface RefreshTokenPair {
  /** The raw token — returned to the client exactly once, never stored. */
  token: string;
  /** What we persist (`sessions.refresh_token_hash`). */
  hash: string;
}

export function generateRefreshToken(): RefreshTokenPair {
  const token = randomToken(48);
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(`refresh:${token}`);
}

/** Refresh tokens embed no data; lookups are by hash. Format check keeps junk out of the DB. */
export function isWellFormedRefreshToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{64}$/.test(token);
}
