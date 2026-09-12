/**
 * Integration test: the real PostgreSQL schema applied to a real PostgreSQL engine (PGlite/WASM)
 * and exercised through the real migration runner and repository helpers.
 *
 * This suite proves the database layer's security and integrity claims:
 *  - migrations apply cleanly, are idempotent, and drift is fatal
 *  - tenant-scoped helpers cannot read or mutate another tenant's rows
 *  - ledger / state-history / audit tables are append-only
 *  - the audit hash chain is computed by the database and tampering is detected
 *  - duplicate live reservations per booking request are impossible
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteClient, isAppendOnlyViolation, type DbClient } from '../src/client';
import { MIGRATIONS } from '../src/migrations';
import { migrateUp, plan } from '../src/migrate';
import { assertScopedSql, tenantScope } from '../src/scope';
import { findById, updateScoped } from '../src/repository';
import { runIntegrityChecks } from '../src/verify';
import { seed } from '../src/cli/seed';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const FREE_PLAN = '11111111-1111-4111-8111-000000000001';

let db: DbClient;

async function createTenantFixtures(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
    [TENANT_A, TENANT_B],
  );
  await db.query(
    `INSERT INTO users (id, tenant_id, email, role, status, full_name)
     VALUES ($1, $2, 'a@example.test', 'USER', 'ACTIVE', 'User A'),
            ($3, $4, 'b@example.test', 'USER', 'ACTIVE', 'User B')`,
    [USER_A, TENANT_A, USER_B, TENANT_B],
  );
  await db.query(
    `INSERT INTO wallets (id, tenant_id, user_id, currency, balance_minor, credit_minor)
     VALUES ($1, $2, $3, 'IRR', 1000000, 0), ($4, $5, $6, 'IRR', 2000000, 0)`,
    [randomUUID(), TENANT_A, USER_A, randomUUID(), TENANT_B, USER_B],
  );
}

async function createBookingRequest(tenantId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO booking_requests
       (id, tenant_id, user_id, status, provider_code, origin_code, destination_code,
        departure_date, passenger_count, currency)
     VALUES ($1, $2, $3, 'SCHEDULED', 'mock', 'THR', 'MHD', CURRENT_DATE + 1, 1, 'IRR')`,
    [id, tenantId, userId],
  );
  return id;
}

beforeAll(async () => {
  db = await PGliteClient.create();
  const result = await migrateUp(db, { skipLock: true, appliedBy: 'integration-test' });
  expect(result.applied).toHaveLength(4);
  await createTenantFixtures();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('migrations', () => {
  it('applies every migration, records checksums and is idempotent', async () => {
    const records = await db.query<{ name: string; checksum: string; applied_by: string }>(
      'SELECT name, checksum, applied_by FROM schema_migrations ORDER BY name',
    );
    expect(records.map((row) => row.name)).toEqual([
      '0001_init',
      '0002_hardening',
      '0003_seed',
      '0004_tenant_integrity',
    ]);
    expect(records.every((row) => row.checksum.length === 64)).toBe(true);
    expect(records.every((row) => row.applied_by === 'integration-test')).toBe(true);

    const second = await migrateUp(db, { skipLock: true });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(4);
  });

  it('refuses to continue when an applied migration drifted from the repository', async () => {
    await db.query("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE name = '0002_hardening'");
    const drifted = await plan(db);
    expect(drifted.drifted.map((entry) => entry.name)).toEqual(['0002_hardening']);
    await expect(migrateUp(db, { skipLock: true })).rejects.toThrow(/checksum mismatch/i);
    const expected = MIGRATIONS.find((migration) => migration.name === '0002_hardening')?.checksum;
    await db.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [expected, '0002_hardening']);
    expect((await plan(db)).drifted).toEqual([]);
  });

  it('seeds the reference catalogue that the platform cannot run without', async () => {
    const summary = await seed(db);
    expect(summary.referenceData.plans).toBe(5);
    expect(summary.referenceData.providers).toBeGreaterThanOrEqual(3);
    expect(summary.referenceData.stations).toBeGreaterThanOrEqual(20);
    expect(summary.referenceData.routes).toBeGreaterThan(0);
    expect(summary.referenceData.flags).toBeGreaterThanOrEqual(15);

    const raja = await db.query<{ code: string; enabled: boolean; compliance_status: string }>(
      "SELECT code, enabled, compliance_status FROM providers WHERE code = 'raja'",
    );
    expect(raja[0]).toMatchObject({ enabled: false, compliance_status: 'NOT_REVIEWED' });

    const autoBooking = await db.query<{ default_enabled: boolean }>(
      "SELECT default_enabled FROM feature_flags WHERE key = 'autoBookingEnabled'",
    );
    expect(autoBooking[0]?.default_enabled).toBe(false);

    const splitBooking = await db.query<{ value: unknown }>(
      "SELECT value FROM system_settings WHERE key = 'booking.allowSplitBooking'",
    );
    expect(splitBooking[0]?.value).toBe(false);
  });
});

describe('tenant isolation (TM-01)', () => {
  it('rejects a statement against a tenant table without a tenant predicate', () => {
    expect(() => assertScopedSql('SELECT * FROM booking_requests WHERE id = $1')).toThrow(/tenant scope violation/i);
    expect(() =>
      assertScopedSql('UPDATE wallets SET balance_minor = 0 WHERE user_id = $1', [USER_A]),
    ).toThrow(/tenant scope violation/i);
    expect(() => assertScopedSql('SELECT * FROM booking_requests WHERE tenant_id = $1', [TENANT_A])).not.toThrow();
  });

  it('returns null rather than another tenant’s row', async () => {
    const requestId = await createBookingRequest(TENANT_A, USER_A);
    const mine = await findById(db, tenantScope(TENANT_A, USER_A), 'booking_requests', requestId);
    expect(mine?.id).toBe(requestId);

    const theirs = await findById(db, tenantScope(TENANT_B, USER_B), 'booking_requests', requestId);
    expect(theirs).toBeNull();
  });

  it('does not let a scoped update touch another tenant’s row', async () => {
    await expect(
      updateScoped(db, tenantScope(TENANT_B, USER_B), 'wallets', await walletIdOf(USER_A), { balance_minor: 0 }),
    ).resolves.toBe(0);

    const untouched = await db.query<{ balance_minor: string }>('SELECT balance_minor FROM wallets WHERE user_id = $1', [
      USER_A,
    ]);
    expect(Number(untouched[0]?.balance_minor)).toBe(1_000_000);
  });

  it('marks every tenant-owned table with a NOT NULL tenant_id', async () => {
    const offenders = await db.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
        WHERE c.column_name = 'tenant_id' AND c.is_nullable = 'YES'
          AND c.table_name <> ALL ($1::text[])`,
      [['audit_events']],
    );
    expect(offenders.map((row) => row.table_name)).toEqual([]);

    // audit_events is the single, documented exception: platform actions have no tenant.
    const platformScoped = await db.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
        JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
        WHERE c.column_name = 'tenant_id' AND c.is_nullable = 'YES'`,
    );
    expect(platformScoped.map((row) => row.table_name)).toEqual(['audit_events']);
  });
});

describe('financial integrity (TM-08)', () => {
  it('makes the ledger append-only', async () => {
    const walletId = await walletIdOf(USER_A);
    const entryId = randomUUID();
    await db.query(
      `INSERT INTO wallet_transactions
         (id, tenant_id, user_id, wallet_id, type, amount_minor, currency, balance_after_minor, idempotency_key)
       VALUES ($1, $2, $3, $4, 'DEPOSIT', 1000, 'IRR', 1001000, $5)`,
      [entryId, TENANT_A, USER_A, walletId, `append-only-${entryId}`],
    );
    await expect(
      db.query('UPDATE wallet_transactions SET amount_minor = 999999 WHERE id = $1', [entryId]),
    ).rejects.toBeDefined();
    await expect(db.query('DELETE FROM wallet_transactions WHERE id = $1', [entryId])).rejects.toBeDefined();

    let caught: unknown;
    try {
      await db.query('UPDATE wallet_transactions SET amount_minor = 1 WHERE id = $1', [entryId]);
    } catch (error) {
      caught = error;
    }
    expect(isAppendOnlyViolation(caught)).toBe(true);
  });

  it('pins the sign of every ledger entry to its type and keeps balances non-negative', async () => {
    const walletId = await walletIdOf(USER_A);
    const insert = (type: string, amountMinor: number, reversalOf: string | null = null): Promise<unknown> =>
      db.query(
        `INSERT INTO wallet_transactions
           (id, tenant_id, user_id, wallet_id, type, amount_minor, currency, balance_after_minor,
            idempotency_key, reversal_of)
         VALUES ($1, $2, $3, $4, $5, $6, 'IRR', 1000000, $7, $8)`,
        [randomUUID(), TENANT_A, USER_A, walletId, type, amountMinor, `sign-${randomUUID()}`, reversalOf],
      );

    // Zero is never a valid ledger entry.
    await expect(insert('ADMIN_ADJUSTMENT', 0)).rejects.toThrow(/check|amount_minor/i);
    // A deposit can never be a debit; a service charge can never be a credit.
    await expect(insert('DEPOSIT', -1000)).rejects.toThrow(/check|sign_by_type/i);
    await expect(insert('SERVICE_CHARGE', 1000)).rejects.toThrow(/check|sign_by_type/i);
    // A reversal must reference the entry it reverses.
    await expect(insert('REVERSAL', 1000)).rejects.toThrow(/check|reversal/i);
    // A credit greater than the balance is rejected by the wallet invariant.
    await expect(db.query('UPDATE wallets SET credit_minor = balance_minor + 1 WHERE id = $1', [walletId])).rejects.toThrow(
      /credit_minor|check/i,
    );
  });

  it('rejects a duplicate idempotency key', async () => {
    const walletId = await walletIdOf(USER_A);
    const key = 'idem-dup-test';
    const insert = (): Promise<unknown> =>
      db.query(
        `INSERT INTO wallet_transactions
           (id, tenant_id, user_id, wallet_id, type, amount_minor, currency, balance_after_minor, idempotency_key)
         VALUES ($1, $2, $3, $4, 'DEPOSIT', 5000, 'IRR', 1005000, $5)`,
        [randomUUID(), TENANT_A, USER_A, walletId, key],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('booking uniqueness (TM-11)', () => {
  it('allows only one live attempt per booking request while allowing terminal retries', async () => {
    const requestId = await createBookingRequest(TENANT_A, USER_A);
    const insertAttempt = (seq: number, state: string, failureClass: string | null = null): Promise<unknown> =>
      db.query(
        `INSERT INTO booking_attempts (id, tenant_id, booking_request_id, attempt_seq, state, failure_class)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), TENANT_A, requestId, seq, state, failureClass],
      );

    await insertAttempt(1, 'FAILED', 'SOLD_OUT'); // terminal attempt is fine
    await insertAttempt(2, 'LOCKED');
    await insertAttempt(3, 'FAILED', 'TIMEOUT');
    await expect(insertAttempt(4, 'RESERVING')).rejects.toThrow(/duplicate key|unique/i);
    // A failed attempt without a failure class is rejected: failures must be explainable.
    await expect(insertAttempt(5, 'FAILED')).rejects.toThrow(/failure_class|check/i);
    await expect(insertAttempt(6, 'EXPIRED')).rejects.toThrow(/failure_class|check/i);
  });

  it('allows only one selected result per booking request', async () => {
    const requestId = await createBookingRequest(TENANT_A, USER_A);
    const insertResult = (fingerprint: string, selected: boolean): Promise<unknown> =>
      db.query(
        `INSERT INTO booking_results
           (id, tenant_id, booking_request_id, provider_code, departure_at, availability_fingerprint, is_selected)
         VALUES ($1, $2, $3, 'mock', now() + interval '1 day', $4, $5)`,
        [randomUUID(), TENANT_A, requestId, fingerprint, selected],
      );
    await insertResult('fp-1', false);
    await insertResult('fp-2', true);
    await expect(insertResult('fp-3', true)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows only one active subscription per user', async () => {
    const insertSubscription = (status: string): Promise<unknown> =>
      db.query(
        `INSERT INTO subscriptions (id, tenant_id, user_id, plan_id, status, current_period_start, current_period_end)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '30 days')`,
        [randomUUID(), TENANT_A, USER_A, FREE_PLAN, status],
      );
    await insertSubscription('ACTIVE');
    await expect(insertSubscription('TRIALING')).rejects.toThrow(/duplicate key|unique/i);
    await insertSubscription('CANCELED'); // terminal subscription is allowed (history)
  });
});

describe('audit trail (TM-19)', () => {
  it('computes the hash chain in-database and verifies it', async () => {
    for (let index = 0; index < 3; index += 1) {
      await db.query(
        `INSERT INTO audit_events (tenant_id, actor_type, actor_user_id, action, target_type, target_id, correlation_id)
         VALUES ($1, 'USER', $2, $3, 'booking_request', 'target', 'corr-1')`,
        [TENANT_A, USER_A, `test.action.${index}`],
      );
    }
    const rows = await db.query<{ prev_hash: string | null; entry_hash: string }>(
      'SELECT prev_hash, entry_hash FROM audit_events ORDER BY id',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.prev_hash).toBeNull();
    expect(rows[1]?.prev_hash).toBe(rows[0]?.entry_hash);
    expect(rows[2]?.prev_hash).toBe(rows[1]?.entry_hash);
    expect(rows[0]?.entry_hash).toMatch(/^[0-9a-f]{64}$/);

    const verified = await db.query<{ ok: boolean; checked: string }>('SELECT ok, checked FROM verify_audit_chain()');
    expect(verified[0]?.ok).toBe(true);
    expect(Number(verified[0]?.checked)).toBe(3);
  });

  it('detects tampering with a historical entry', async () => {
    await db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    await db.query("UPDATE audit_events SET action = 'tampered' WHERE action = 'test.action.1'");
    const verified = await db.query<{ ok: boolean; first_broken_id: string | null }>(
      'SELECT ok, first_broken_id FROM verify_audit_chain()',
    );
    expect(verified[0]?.ok).toBe(false);
    expect(Number(verified[0]?.first_broken_id)).toBe(2);
    await db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  });

  it('refuses to delete audit history even for the owner of the connection path', async () => {
    let caught: unknown;
    try {
      await db.query('DELETE FROM audit_events');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isAppendOnlyViolation(caught)).toBe(true);
  });
});

describe('integrity checks', () => {
  it('reports findings as evidence rows rather than bare booleans', async () => {
    const { results, ok } = await runIntegrityChecks(db);
    const byName = new Map(results.map((result) => [result.name, result]));
    expect(byName.get('append_only_triggers')?.detail).toMatch(/all append-only triggers present/);
    expect(byName.get('money_invariants')?.detail).toMatch(/ledger amounts and currencies are valid/);
    expect(byName.get('tenant_columns_not_null')?.ok).toBe(true);
    expect(byName.get('duplicate_live_reservations')?.ok).toBe(true);
    expect(byName.get('idempotency_uniqueness')?.ok).toBe(true);
    // The intentionally tampered audit row means the overall verdict must be false — checks are
    // wired to real evidence, not to a constant.
    expect(byName.get('audit_chain')?.ok).toBe(false);
    expect(ok).toBe(false);
  });
});

async function walletIdOf(userId: string): Promise<string> {
  const rows = await db.query<{ id: string }>('SELECT id FROM wallets WHERE user_id = $1', [userId]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no wallet for ${userId}`);
  return id;
}
