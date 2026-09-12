/**
 * Forward-only migration runner with checksum verification and a cross-process advisory lock.
 *
 * Properties that matter for operations:
 *  - `schema_migrations` records name, checksum, duration and who applied it
 *  - an already-applied migration whose checksum changed is a hard error (prevents silent drift)
 *  - a session-level advisory lock serializes concurrent runners (two API replicas booting at once)
 *  - each migration runs inside its own transaction; DDL is transactional in PostgreSQL
 */
import { createHash } from 'node:crypto';
import type { DbClient } from './client';
import { DbError } from './client';
import { MIGRATIONS, type EmbeddedMigration } from './migrations';

const LOCK_KEY = 8_140_101_001; // arbitrary but stable: raja1 migration lock

export interface MigrationRecord {
  /** Index signature so the row type is usable as a `QueryResultRow`. */
  [column: string]: unknown;
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number;
  applied_by: string;
}

export interface MigrationPlan {
  pending: EmbeddedMigration[];
  applied: MigrationRecord[];
  drifted: { name: string; expected: string; actual: string }[];
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  durationMs: number;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function ensureMigrationsTable(db: DbClient): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0,
      applied_by  text NOT NULL DEFAULT ''
    );
  `);
}

export async function listApplied(db: DbClient): Promise<MigrationRecord[]> {
  const rows = await db.query<MigrationRecord>(
    'SELECT name, checksum, applied_at::text AS applied_at, duration_ms, applied_by FROM schema_migrations ORDER BY name',
  );
  return rows;
}

export async function plan(db: DbClient): Promise<MigrationPlan> {
  await ensureMigrationsTable(db);
  const applied = await listApplied(db);
  const appliedByName = new Map(applied.map((row) => [row.name, row]));
  const pending: EmbeddedMigration[] = [];
  const drifted: MigrationPlan['drifted'] = [];

  for (const migration of MIGRATIONS) {
    const record = appliedByName.get(migration.name);
    if (!record) {
      pending.push(migration);
      continue;
    }
    if (record.checksum !== migration.checksum) {
      drifted.push({ name: migration.name, expected: migration.checksum, actual: record.checksum });
    }
  }
  return { pending, applied, drifted };
}

export interface MigrateOptions {
  /** Identifies who applied the migration (image tag, hostname, CI run). */
  appliedBy?: string;
  /** Skip the advisory lock (used by PGlite tests, which are single-connection anyway). */
  skipLock?: boolean;
  onProgress?: (message: string) => void;
}

export async function migrateUp(db: DbClient, options: MigrateOptions = {}): Promise<MigrateResult> {
  const started = Date.now();
  const { pending, drifted } = await plan(db);
  if (drifted.length > 0) {
    throw new DbError(
      `migration checksum mismatch (database drifted from the repository): ${drifted
        .map((d) => `${d.name} expected ${d.expected.slice(0, 12)}… found ${d.actual.slice(0, 12)}…`)
        .join(', ')}`,
    );
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const appliedBy = options.appliedBy ?? `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`;

  if (!options.skipLock) {
    await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  }
  try {
    for (const migration of pending) {
      const start = Date.now();
      options.onProgress?.(`applying ${migration.name}`);
      await db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms, applied_by) VALUES ($1, $2, $3, $4)',
          [migration.name, migration.checksum, Date.now() - start, appliedBy],
        );
      });
      applied.push(migration.name);
    }
    for (const record of await listApplied(db)) {
      if (!applied.includes(record.name)) skipped.push(record.name);
    }
  } finally {
    if (!options.skipLock) {
      await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  }

  return { applied, skipped, durationMs: Date.now() - started };
}

export async function migrateStatus(db: DbClient): Promise<MigrationPlan> {
  return plan(db);
}

/**
 * Rollback is intentionally *not* implemented: forward-only migrations are safer for a financial
 * system (a down-migration that drops a column can destroy audit evidence). Recovery is done by
 * restoring a backup and replaying forward migrations, or by applying a corrective migration.
 */
export function migrateDown(): never {
  throw new DbError('down migrations are disabled by design; write a corrective migration instead');
}
