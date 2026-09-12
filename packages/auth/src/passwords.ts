/**
 * Password lifecycle (spec § 45, TM-04 brute force / credential stuffing).
 *
 * Argon2id hashing lives in `@raja/crypto`; this module owns the *policy* and the pepper, so the
 * two concerns can be audited separately.
 */
import { hashPassword, needsRehash, verifyPassword } from '@raja/crypto';
import { checkPasswordStrength, validationError, type PasswordPolicy, DEFAULT_PASSWORD_POLICY } from '@raja/shared';

export interface PasswordContext {
  /** Server-side pepper from config (`PASSWORD_PEPPER`); never logged, never stored with the hash. */
  pepper: string;
  policy?: PasswordPolicy;
}

/** Hash a password for storage. Returns the PHC string (`$argon2id$…`). */
export async function toPasswordHash(password: string, context: PasswordContext): Promise<string> {
  const policy = context.policy ?? DEFAULT_PASSWORD_POLICY;
  const check = checkPasswordStrength(password, policy);
  if (!check.valid) {
    // Reasons are policy identifiers (never the password itself, which must not reach logs).
    throw validationError('password does not meet the policy', { reasons: check.reasons });
  }
  return hashPassword(peppered(password, context.pepper));
}

/**
 * Verify a password. Timing is dominated by argon2; a missing/blank hash short-circuits to `false`
 * so that "user not found" and "wrong password" are indistinguishable to an attacker and to logs.
 */
export async function verifyUserPassword(
  password: string,
  storedHash: string | null | undefined,
  context: PasswordContext,
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await verifyPassword(storedHash, peppered(password, context.pepper));
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(storedHash: string): boolean {
  try {
    return needsRehash(storedHash);
  } catch {
    return true;
  }
}

/**
 * Pepper is applied before hashing. `PASSWORD_PEPPER` is required in production by `@raja/config`;
 * a blank pepper is tolerated only in development/test so local fixtures keep working.
 */
function peppered(password: string, pepper: string): string {
  return `${password}\u0000${pepper}`;
}
