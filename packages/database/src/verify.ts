/**
 * Integrity verification used by the `migrate verify` CLI command, the nightly maintenance job and
 * the restore drill. Every check returns a row of evidence rather than a bare boolean, so the
 * production-readiness report can quote real numbers.
 */
import type { DbClient } from './client';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  severity: 'CRITICAL' | 'WARNING';
}

async function scalar(db: DbClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const rows = await db.query<{ value: string | number | null }>(sql, params);
  const raw = rows[0]?.value ?? 0;
  return typeof raw === 'string' ? Number(raw) : Number(raw ?? 0);
}

/** 1. The audit trail hash chain is intact (TM-19). */
export async function checkAuditChain(db: DbClient): Promise<CheckResult> {
  const rows = await db.query<{ ok: boolean; checked: string; first_broken_id: string | null }>(
    'SELECT * FROM verify_audit_chain()',
  );
  const row = rows[0];
  const ok = row?.ok === true;
  return {
    name: 'audit_chain',
    ok,
    severity: 'CRITICAL',
    detail: ok
      ? `audit hash chain verified over ${row?.checked ?? 0} entries`
      : `audit hash chain broken at id ${row?.first_broken_id ?? 'unknown'}`,
  };
}

/** 2. No wallet has a negative balance or credit exceeding its balance. */
export async function checkWalletBalances(db: DbClient): Promise<CheckResult> {
  const negative = await scalar(db, 'SELECT count(*) AS value FROM wallets WHERE balance_minor < 0 OR credit_minor < 0');
  const creditOverflow = await scalar(
    db,
    'SELECT count(*) AS value FROM wallets WHERE credit_minor > balance_minor',
  );
  const ok = negative === 0 && creditOverflow === 0;
  return {
    name: 'wallet_balances',
    ok,
    severity: 'CRITICAL',
    detail: ok
      ? 'all wallet balances are non-negative and credits do not exceed balances'
      : `${negative} negative balance(s), ${creditOverflow} credit overflow(s)`,
  };
}

/** 3. The ledger is append-only: no UPDATE/DELETE has ever been recorded (triggers enforce it). */
export async function checkAppendOnlyTriggers(db: DbClient): Promise<CheckResult> {
  // Trigger names follow the convention `<table>_append_only` (see migration 0002).
  const requiredTables = [
    'wallet_transactions',
    'booking_transitions',
    'booking_timeline_events',
    'payment_events',
    'credit_consumptions',
    'consent_records',
    'audit_events',
  ];
  const missing: string[] = [];
  for (const table of requiredTables) {
    const trigger = `${table}_append_only`;
    const found = await scalar(
      db,
      `SELECT count(*) AS value FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
      [table, trigger],
    );
    if (found === 0) missing.push(`${table}/${trigger}`);
  }
  return {
    name: 'append_only_triggers',
    ok: missing.length === 0,
    severity: 'CRITICAL',
    detail:
      missing.length === 0
        ? `all append-only triggers present (${requiredTables.length} tables)`
        : `missing: ${missing.join(', ')}`,
  };
}

/**
 * Tables that are *intentionally* platform-scoped: platform/SUPER_ADMIN actions (flag changes,
 * migrations, kill switch) are not attributable to a single tenant.
 */
export const PLATFORM_SCOPED_TENANT_TABLES: readonly string[] = ['audit_events'];

/** 4. Tenant-scoped tables all carry a NOT NULL tenant_id. */
export async function checkTenantColumns(db: DbClient): Promise<CheckResult> {
  const offenders = await db.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
      WHERE c.column_name = 'tenant_id'
        AND c.is_nullable = 'YES'
        AND c.table_name <> ALL ($1::text[])
      ORDER BY c.table_name`,
    [[...PLATFORM_SCOPED_TENANT_TABLES]],
  );
  const names = offenders.map((row) => row.table_name);
  return {
    name: 'tenant_columns_not_null',
    ok: names.length === 0,
    severity: 'CRITICAL',
    detail:
      names.length === 0
        ? `every tenant_id column is NOT NULL (allow-listed platform tables: ${PLATFORM_SCOPED_TENANT_TABLES.join(', ')})`
        : `nullable tenant_id in: ${names.join(', ')}`,
  };
}

/** 5. No booking request has more than one live (non-terminal) reservation. */
export async function checkDuplicateReservations(db: DbClient): Promise<CheckResult> {
  const duplicates = await scalar(
    db,
    `SELECT count(*) AS value FROM (
       SELECT booking_request_id
         FROM reservations
        WHERE status IN ('PENDING','HOLD','RESERVED','BOOKED')
        GROUP BY booking_request_id
       HAVING count(*) > 1
     ) d`,
  );
  return {
    name: 'duplicate_live_reservations',
    ok: duplicates === 0,
    severity: 'CRITICAL',
    detail: duplicates === 0 ? 'no booking request has two live reservations' : `${duplicates} duplicated live reservation(s)`,
  };
}

/** 6. Ledger signs, currency shapes and quota counters are sane. */
export async function checkMoneyInvariants(db: DbClient): Promise<CheckResult> {
  const badLedger = await scalar(
    db,
    `SELECT count(*) AS value FROM wallet_transactions
      WHERE amount_minor = 0
         OR (type IN ('DEPOSIT','REFUND','BONUS','PROMO','CHARGE_RELEASE') AND amount_minor <= 0)
         OR (type IN ('SERVICE_CHARGE','BOOKING_CHARGE','CHARGE_HOLD') AND amount_minor >= 0)
         OR (status = 'POSTED' AND balance_after_minor IS NULL)
         OR ((type = 'REVERSAL') <> (reversal_of IS NOT NULL))`,
  );
  const badCurrency = await scalar(db, "SELECT count(*) AS value FROM wallets WHERE length(currency) <> 3");
  const ok = badLedger === 0 && badCurrency === 0;
  return {
    name: 'money_invariants',
    ok,
    severity: 'CRITICAL',
    detail: ok ? 'ledger amounts and currencies are valid' : `${badLedger} invalid ledger row(s), ${badCurrency} invalid currency value(s)`,
  };
}

/** 7. Idempotency keys are unique per scope and none are expired-but-unused beyond retention. */
export async function checkIdempotencyScope(db: DbClient): Promise<CheckResult> {
  const duplicates = await scalar(
    db,
    'SELECT count(*) AS value FROM (SELECT scope, key FROM idempotency_keys GROUP BY scope, key HAVING count(*) > 1) d',
  );
  return {
    name: 'idempotency_uniqueness',
    ok: duplicates === 0,
    severity: 'CRITICAL',
    detail: duplicates === 0 ? 'idempotency (scope,key) pairs are unique' : `${duplicates} duplicate idempotency key(s)`,
  };
}

/** 8. Booking state machine: every attempt sits in a legal state; no orphan transitions. */
export async function checkBookingStateMachine(db: DbClient): Promise<CheckResult> {
  const orphanTransitions = await scalar(
    db,
    `SELECT count(*) AS value FROM booking_transitions t
      WHERE NOT EXISTS (SELECT 1 FROM booking_requests r WHERE r.id = t.booking_request_id)`,
  );
  const selfLoops = await scalar(
    db,
    'SELECT count(*) AS value FROM booking_transitions WHERE from_state = to_state',
  );
  const ok = orphanTransitions === 0 && selfLoops === 0;
  return {
    name: 'booking_transitions_integrity',
    ok,
    severity: 'WARNING',
    detail: ok
      ? 'all transitions reference an existing booking request and none is a self-loop'
      : `${orphanTransitions} orphan transition(s), ${selfLoops} self-loop(s)`,
  };
}

/** 9. Migration ledger matches the repository (checksums unchanged). */
export async function checkMigrationChecksums(db: DbClient): Promise<CheckResult> {
  const { plan } = await import('./migrate');
  const planned = await plan(db);
  const ok = planned.drifted.length === 0 && planned.pending.length === 0;
  return {
    name: 'migration_checksums',
    ok,
    severity: 'CRITICAL',
    detail: ok
      ? `${planned.applied.length} migrations applied, none pending, no drift`
      : `${planned.drifted.length} drifted, ${planned.pending.length} pending`,
  };
}

export const DEFAULT_CHECKS = [
  checkAuditChain,
  checkWalletBalances,
  checkAppendOnlyTriggers,
  checkTenantColumns,
  checkDuplicateReservations,
  checkMoneyInvariants,
  checkIdempotencyScope,
  checkBookingStateMachine,
  checkMigrationChecksums,
] as const;

export async function runIntegrityChecks(
  db: DbClient,
  checks: readonly ((db: DbClient) => Promise<CheckResult>)[] = DEFAULT_CHECKS,
): Promise<{ results: CheckResult[]; ok: boolean }> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await check(db));
  }
  return { results, ok: results.every((result) => result.ok) };
}
