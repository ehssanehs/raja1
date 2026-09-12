/**
 * Database client abstraction.
 *
 * Two implementations are provided:
 *  - `PgClient`     — production: node-postgres pool with transactions and typed helpers
 *  - `PGliteClient` — tests/local: the real PostgreSQL engine compiled to WASM
 *
 * Both speak the same `DbClient` interface, so integration tests exercise genuine PostgreSQL
 * semantics (constraints, triggers, partial indexes, plpgsql) without a server (ADR-0003).
 */
import type { PGlite } from '@electric-sql/pglite';

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface QueryOptions {
  /** Correlation id used for slow-query logging and error context. */
  correlationId?: string;
  /** Statement timeout in ms (production client only). */
  timeoutMs?: number;
}

export interface DbClient {
  /** Parameterized query (never string interpolation). */
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<T[]>;
  /** Execute a multi-statement script (migrations, seeds). */
  exec(sql: string): Promise<void>;
  /** Run a function inside a transaction; rolls back on throw. */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /** True when connected and able to answer a trivial query. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class DbError extends Error {
  constructor(message: string, override readonly cause?: unknown, readonly code?: string) {
    super(message);
    this.name = 'DbError';
  }
}

/** Postgres error codes we translate into domain behaviour. */
export const PG_ERROR_CODES = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  RESTRICT_VIOLATION: '23001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === PG_ERROR_CODES.UNIQUE_VIOLATION;
}

export function isCheckViolation(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === PG_ERROR_CODES.CHECK_VIOLATION;
}

export function isAppendOnlyViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === PG_ERROR_CODES.RESTRICT_VIOLATION || code === PG_ERROR_CODES.CHECK_VIOLATION;
}

export function pgErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------- PGlite ----
/** PGlite-backed client used by tests and by local development without a server. */
export class PGliteClient implements DbClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PGlite) {}

  static async create(dataDir = 'memory://'): Promise<PGliteClient> {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = dataDir === 'memory://' ? new PGlite() : new PGlite(dataDir);
    await db.waitReady;
    return new PGliteClient(db);
  }

  /** Serialize access: PGlite is single-connection, so overlapping statements must not interleave. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.serialize(async () => {
      const result = await this.db.query<T>(sql, params as unknown[]);
      return result.rows;
    });
  }

  async exec(sql: string): Promise<void> {
    await this.serialize(async () => {
      await this.db.exec(sql);
    });
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.db.exec('BEGIN');
      const txClient: DbClient = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
          const result = await this.db.query<R>(sql, params as unknown[]);
          return result.rows;
        },
        exec: async (statement: string) => {
          await this.db.exec(statement);
        },
        transaction: () => {
          throw new DbError('nested transactions are not supported; use savepoints explicitly');
        },
        ping: async () => true,
        close: async () => undefined,
      };
      try {
        const result = await fn(txClient);
        await this.db.exec('COMMIT');
        return result;
      } catch (error) {
        await this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

// ------------------------------------------------------------- node-postgres --
interface PgPoolLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryResultRow[] }>;
  connect(): Promise<{
    query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryResultRow[] }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

export interface PgClientOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

/** Production client. `pg` is imported lazily so tests never need a server. */
export class PgClient implements DbClient {
  private constructor(private readonly pool: PgPoolLike, private readonly options: PgClientOptions) {}

  static async create(options: PgClientOptions): Promise<PgClient> {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: options.connectionString,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      max: options.max ?? 10,
      application_name: options.applicationName ?? 'raja1',
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    return new PgClient(pool as unknown as PgPoolLike, options);
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[]);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    const txClient: DbClient = {
      query: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
        const result = await connection.query(sql, params as unknown[]);
        return result.rows as R[];
      },
      exec: async (statement: string) => {
        await connection.query(statement);
      },
      transaction: () => {
        throw new DbError('nested transactions are not supported; use savepoints explicitly');
      },
      ping: async () => true,
      close: async () => undefined,
    };
    try {
      await connection.query('BEGIN');
      const result = await fn(txClient);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
