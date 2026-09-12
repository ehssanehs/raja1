/**
 * Tenant-scoped repository helpers.
 *
 * The rule is simple and non-negotiable: **no repository method works without a scope**.
 * `scopedQuery`/`scopedTransaction` assert that the generated SQL contains a tenant predicate
 * (defense in depth behind the typed scope parameter), and errors are raised as
 * `TenantScopeViolation` so they surface in monitoring as security events.
 */
import type { DbClient, QueryResultRow } from './client';
import { assertScopedSql, isTenantScope, type PlatformScope, type Scope, type TenantScope } from './scope';

export interface FindOptions {
  columns?: readonly string[];
  /** Include soft-deleted rows (passengers/support data use `deleted_at`). */
  includeDeleted?: boolean;
}

export abstract class ScopedRepository {
  constructor(protected readonly db: DbClient) {}

  /** Parameterized, scope-asserted query. */
  protected async scopedQuery<T extends QueryResultRow = QueryResultRow>(
    scope: Scope,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    assertScopedSql(sql, params);
    return this.db.query<T>(sql, params);
  }

  protected scopedTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  protected tenantId(scope: Scope): string {
    if (!isTenantScope(scope)) {
      throw new TenantScopeRequiredError('this operation requires a tenant scope');
    }
    return (scope as TenantScope).tenantId;
  }
}

export class TenantScopeRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeRequiredError';
  }
}

/**
 * Generic scoped read used by services and by the IDOR sweep test: the WHERE clause always
 * contains `tenant_id = $1` first, so a wrong/absent tenant cannot return another tenant's row.
 */
export async function findById<T extends QueryResultRow = QueryResultRow>(
  db: DbClient,
  scope: TenantScope | PlatformScope,
  table: string,
  id: string,
  options: FindOptions = {},
): Promise<T | null> {
  const columns = (options.columns ?? ['*']).join(', ');
  if (isTenantScope(scope)) {
    const sql = `SELECT ${columns} FROM ${table} WHERE tenant_id = $1 AND id = $2 LIMIT 1`;
    assertScopedSql(sql, [scope.tenantId, id]);
    const rows = await db.query<T>(sql, [scope.tenantId, id]);
    return rows[0] ?? null;
  }
  if (!options.includeDeleted) {
    // Platform staff access still goes through an explicit, audited path (see AuditService).
  }
  const sql = `SELECT ${columns} FROM ${table} WHERE id = $1 LIMIT 1`;
  const rows = await db.query<T>(sql, [id]);
  return rows[0] ?? null;
}

/** Scoped list with pagination; `tenant_id` is always the first predicate. */
export async function listScoped<T extends QueryResultRow = QueryResultRow>(
  db: DbClient,
  scope: TenantScope,
  table: string,
  options: { where?: string; params?: readonly unknown[]; orderBy?: string; limit?: number; offset?: number } = {},
): Promise<T[]> {
  const params: unknown[] = [scope.tenantId, ...(options.params ?? [])];
  const where = options.where ? ` AND ${options.where}` : '';
  const orderBy = options.orderBy ?? 'created_at DESC';
  const limit = Math.min(options.limit ?? 20, 100);
  const offset = options.offset ?? 0;
  const sql = `SELECT * FROM ${table} WHERE tenant_id = $1${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  assertScopedSql(sql, params);
  return db.query<T>(sql, params);
}

/**
 * Scoped update: the tenant predicate is part of the UPDATE, so a cross-tenant id is a no-op
 * (zero rows) rather than a silent write.
 */
export async function updateScoped(
  db: DbClient,
  scope: TenantScope,
  table: string,
  id: string,
  assignments: Record<string, unknown>,
): Promise<number> {
  const keys = Object.keys(assignments);
  if (keys.length === 0) return 0;
  const params: unknown[] = [scope.tenantId, id];
  const setClause = keys
    .map((key) => {
      params.push(assignments[key]);
      return `${key} = $${params.length}`;
    })
    .join(', ');
  const sql = `UPDATE ${table} SET ${setClause} WHERE tenant_id = $1 AND id = $2`;
  assertScopedSql(sql, params);
  const rows = await db.query<{ id: string }>(`${sql} RETURNING id`, params);
  return rows.length;
}

export async function deleteScoped(
  db: DbClient,
  scope: TenantScope,
  table: string,
  id: string,
): Promise<number> {
  const sql = `DELETE FROM ${table} WHERE tenant_id = $1 AND id = $2`;
  assertScopedSql(sql, [scope.tenantId, id]);
  const rows = await db.query<{ id: string }>(`${sql} RETURNING id`, [scope.tenantId, id]);
  return rows.length;
}
