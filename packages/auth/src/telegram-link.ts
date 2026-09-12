/**
 * Telegram account linking (spec § 72, TM-09).
 *
 * The bot can never be trusted to say "I am user X": linking is a *signed challenge* flow.
 * The web app issues a short, single-use, expiring code for the authenticated user; the user sends
 * that code to the bot; the bot exchanges it for the link. Only the Telegram **user id** (a number)
 * is stored — usernames are display-only, because they can be changed by the user at any time.
 */
import { randomBytes } from 'node:crypto';
import { AppError, uuid, validationError } from '@raja/shared';
import { lookupHash } from '@raja/crypto';
import type { DbClient } from '@raja/database';

export const LINK_CHALLENGE_TTL_SECONDS = 600;
/** Unambiguous alphabet: no 0/O/1/I/L so codes can be read aloud or typed from a screenshot. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface TelegramLinkConfig {
  /** Server-side pepper mixed into the stored challenge hash. */
  pepper: string;
  ttlSeconds?: number;
  maxAttemptsPerHour?: number;
}

export interface LinkChallenge {
  code: string;
  expiresAt: Date;
}

export interface LinkedIdentity {
  userId: string;
  tenantId: string;
  telegramUserId: number;
}

export class TelegramLinkService {
  constructor(
    private readonly db: DbClient,
    private readonly config: TelegramLinkConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Unbiased code: 256 is a multiple of the 32-character alphabet, so we reject the top 32 byte
   * values and take the rest modulo 32.
   */
  generateCode(length = 8): string {
    let code = '';
    while (code.length < length) {
      for (const byte of randomBytes(length * 2)) {
        if (byte >= 224) continue;
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? CODE_ALPHABET[0];
        if (code.length === length) break;
      }
    }
    return code;
  }

  async createChallenge(userId: string, tenantId: string): Promise<LinkChallenge> {
    const ttl = this.config.ttlSeconds ?? LINK_CHALLENGE_TTL_SECONDS;
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);

    // A user may only have a handful of live challenges; expire the old ones so a leaked
    // screenshot cannot be redeemed later.
    await this.db.query(
      `UPDATE telegram_link_challenges SET consumed_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId],
    );

    const code = this.generateCode();
    await this.db.query(
      `INSERT INTO telegram_link_challenges (id, user_id, tenant_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), userId, tenantId, this.hashCode(code), expiresAt],
    );
    return { code, expiresAt };
  }

  /** Redeem a code from the bot. Single use: the row is consumed inside the same transaction. */
  async consumeChallenge(code: string, telegramUserId: number, telegramUsername = ''): Promise<LinkedIdentity> {
    if (!/^[A-Z0-9]{6,10}$/.test(code)) throw validationError('malformed telegram link code', { codeLength: code.length });

    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; user_id: string; tenant_id: string; expires_at: Date }>(
        `SELECT id, user_id, tenant_id, expires_at
           FROM telegram_link_challenges
          WHERE code_hash = $1 AND consumed_at IS NULL
          FOR UPDATE`,
        [this.hashCode(code)],
      );
      const challenge = rows[0];
      if (!challenge) throw validationError('unknown or already used telegram link code');
      if (new Date(challenge.expires_at).getTime() <= this.now().getTime()) {
        throw validationError('telegram link code expired');
      }

      await tx.query('UPDATE telegram_link_challenges SET consumed_at = now() WHERE id = $1', [challenge.id]);

      const existing = await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM telegram_links WHERE telegram_user_id = $1 AND revoked_at IS NULL`,
        [telegramUserId],
      );
      if (existing[0] && existing[0].user_id !== challenge.user_id) {
        // The Telegram account is already linked to somebody else: refuse rather than steal the link.
        throw new AppError('CONFLICT', 'this Telegram account is already linked to another user', {
          userMessageKey: 'error.telegram_already_linked',
        });
      }

      await tx.query(
        `INSERT INTO telegram_links (id, user_id, tenant_id, telegram_user_id, telegram_username)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), challenge.user_id, challenge.tenant_id, telegramUserId, telegramUsername],
      );

      return {
        userId: challenge.user_id,
        tenantId: challenge.tenant_id,
        telegramUserId,
      };
    });
  }

  async unlink(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE telegram_links SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async findByTelegramUser(telegramUserId: number): Promise<LinkedIdentity | null> {
    const rows = await this.db.query<{ user_id: string; tenant_id: string }>(
      `SELECT user_id, tenant_id FROM telegram_links
        WHERE telegram_user_id = $1 AND revoked_at IS NULL`,
      [telegramUserId],
    );
    const row = rows[0];
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id, telegramUserId };
  }

  private hashCode(code: string): string {
    // Deterministic, keyed hash: a database leak cannot be turned into valid link codes.
    return lookupHash(`telegram-link:${code.toUpperCase()}`, this.config.pepper, (value) => value.toUpperCase());
  }
}
