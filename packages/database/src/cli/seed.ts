#!/usr/bin/env node
/**
 * `raja-seed` — development fixtures for local work and demos.
 *
 * Reference data (plans, feature flags, settings, providers, stations, routes) already ships as
 * migration `0003_seed`, so this command only adds *demo* rows:
 *
 *   raja-seed                 reference data only (verifies it is present)
 *   raja-seed --demo          add a demo tenant with an admin/operator/user, wallet + ledger
 *   raja-seed --demo --reset  delete only the demo tenant first (never touches other rows)
 *
 * Safety: refuses to run in production unless `--i-know-this-is-not-production` is passed, and the
 * demo tenant id is a fixed UUID so `--reset` can never delete anything else.
 */
import { randomUUID } from 'node:crypto';
import { getConfig } from '@raja/config';
import { hashPassword } from '@raja/crypto';
import type { DbClient } from '../client';
import { PgClient, PGliteClient } from '../client';
import { plan } from '../migrate';

/** Fixed id: `--reset` can only ever touch rows owned by this tenant. */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-0000000000d1';
export const DEMO_TENANT_SLUG = 'demo';

export interface SeedOptions {
  demo?: boolean;
  reset?: boolean;
  demoPassword?: string;
}

export interface SeedSummary {
  referenceData: { plans: number; features: number; flags: number; settings: number; providers: number; stations: number; routes: number };
  demo?: { tenantId: string; users: string[]; walletId: string };
}

async function count(db: DbClient, table: string, where = ''): Promise<number> {
  const rows = await db.query<{ value: string }>(`SELECT count(*)::text AS value FROM ${table} ${where}`);
  return Number(rows[0]?.value ?? 0);
}

export async function seed(db: DbClient, options: SeedOptions = {}): Promise<SeedSummary> {
  const migrationStatus = await plan(db);
  if (migrationStatus.pending.length > 0) {
    throw new Error(
      `database is not migrated: ${migrationStatus.pending.length} pending migration(s). Run raja-migrate up first.`,
    );
  }

  const referenceData = {
    plans: await count(db, 'plans'),
    features: await count(db, 'plan_features'),
    flags: await count(db, 'feature_flags'),
    settings: await count(db, 'system_settings'),
    providers: await count(db, 'providers'),
    stations: await count(db, 'provider_stations'),
    routes: await count(db, 'provider_routes'),
  };
  if (referenceData.plans === 0 || referenceData.providers === 0) {
    throw new Error('reference data missing — migration 0003_seed did not run');
  }

  const summary: SeedSummary = { referenceData };
  if (!options.demo) return summary;

  const config = getConfig();
  if (config.env === 'production' && !process.argv.includes('--i-know-this-is-not-production')) {
    throw new Error('refusing to create demo data in production (pass --i-know-this-is-not-production to override)');
  }

  if (options.reset) {
    await db.query('DELETE FROM tenants WHERE id = $1 AND slug = $2', [DEMO_TENANT_ID, DEMO_TENANT_SLUG]);
  }

  let demoWalletId = '';
  const password = options.demoPassword ?? 'Demo-password-123!';
  const passwordHash = await hashPassword(password);
  const freePlanId = '11111111-1111-4111-8111-000000000001';

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO tenants (id, slug, name, status, timezone, locale)
       VALUES ($1, $2, 'Demo tenant', 'ACTIVE', 'Asia/Tehran', 'fa')
       ON CONFLICT (id) DO NOTHING`,
      [DEMO_TENANT_ID, DEMO_TENANT_SLUG],
    );

    const users = [
      { email: 'admin@demo.local', role: 'ADMIN', name: 'مدیر نمونه', status: 'ACTIVE' },
      { email: 'operator@demo.local', role: 'OPERATOR', name: 'اپراتور نمونه', status: 'ACTIVE' },
      { email: 'user@demo.local', role: 'USER', name: 'کاربر نمونه', status: 'ACTIVE' },
    ];
    const userIds: string[] = [];
    for (const user of users) {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, role, status, full_name, locale, timezone, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'fa', 'Asia/Tehran', now())
         ON CONFLICT (tenant_id, email) DO NOTHING`,
        [id, DEMO_TENANT_ID, user.email, passwordHash, user.role, user.status, user.name],
      );
      const rows = await tx.query<{ id: string }>('SELECT id FROM users WHERE tenant_id = $1 AND email = $2', [
        DEMO_TENANT_ID,
        user.email,
      ]);
      userIds.push(rows[0]?.id ?? id);
    }

    const walletId = randomUUID();
    await tx.query(
      `INSERT INTO wallets (id, tenant_id, user_id, currency, balance_minor, credit_minor)
       VALUES ($1, $2, $3, 'IRR', 5000000, 0)
       ON CONFLICT (user_id, currency) DO NOTHING`,
      [walletId, DEMO_TENANT_ID, userIds[2]],
    );
    const walletRows = await tx.query<{ id: string }>('SELECT id FROM wallets WHERE user_id = $1', [userIds[2] ?? '']);
    const actualWalletId = walletRows[0]?.id ?? walletId;
    demoWalletId = actualWalletId;

    // Append-only ledger: a single opening deposit, written once.
    await tx.query(
      `INSERT INTO wallet_transactions
         (id, tenant_id, user_id, wallet_id, type, status, amount_minor, currency, balance_after_minor,
          reference_type, idempotency_key, description_key)
       VALUES ($1, $2, $3, $4, 'DEPOSIT', 'POSTED', 5000000, 'IRR', 5000000, 'demo', $5, 'wallet.demo.opening_balance')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), DEMO_TENANT_ID, userIds[2], actualWalletId, 'demo:opening-balance'],
    );

    // Every demo user starts on the FREE plan via a subscription row (entitlements are data).
    for (const userId of userIds) {
      await tx.query(
        `INSERT INTO subscriptions (id, tenant_id, user_id, plan_id, status, current_period_start, current_period_end)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now(), now() + interval '1 year')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), DEMO_TENANT_ID, userId, freePlanId],
      );
    }
  });

  summary.demo = {
    tenantId: DEMO_TENANT_ID,
    users: ['admin@demo.local', 'operator@demo.local', 'user@demo.local'],
    walletId: demoWalletId,
  };
  return summary;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pgliteIndex = argv.indexOf('--pglite');
  const usePglite = pgliteIndex >= 0;
  const pgliteDir = usePglite && argv[pgliteIndex + 1] && !argv[pgliteIndex + 1]?.startsWith('--') ? argv[pgliteIndex + 1] : undefined;
  const db: DbClient = usePglite
    ? await PGliteClient.create(pgliteDir ?? 'memory://')
    : await PgClient.create({ connectionString: getConfig().db.url, ssl: getConfig().db.ssl, applicationName: 'raja-seed' });
  try {
    const summary = await seed(db, { demo: argv.includes('--demo'), reset: argv.includes('--reset') });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`[seed] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
