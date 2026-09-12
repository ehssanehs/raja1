#!/usr/bin/env node
/**
 * `raja-migrate` — database lifecycle CLI.
 *
 *   raja-migrate up                 apply pending migrations (advisory-locked, checksum-verified)
 *   raja-migrate status             list applied / pending / drifted migrations
 *   raja-migrate verify             run integrity checks (audit chain, ledger, triggers, …)
 *   raja-migrate bootstrap          up + verify (used by container entrypoints and CI)
 *
 * Connection resolution (in order):
 *   1. `--url <postgres://…>`             explicit override
 *   2. `--pglite [dir]`                   embedded PostgreSQL (tests, local demo; default memory)
 *   3. `DATABASE_URL` from @raja/config   normal path for docker compose / production
 *
 * Exit codes: 0 success, 1 failure (safe for `docker compose` health gating and CI).
 */
import { getConfig } from '@raja/config';
import { PgClient, PGliteClient, type DbClient } from '../client';
import { migrateStatus, migrateUp } from '../migrate';
import { runIntegrityChecks } from '../verify';

interface CliArgs {
  command: 'up' | 'status' | 'verify' | 'bootstrap';
  url?: string;
  pglite?: string | true;
  appliedBy?: string;
}

const USAGE = `raja-migrate <up|status|verify|bootstrap> [--url <postgres://…>] [--pglite [dir]] [--applied-by <id>]

  up         apply pending migrations
  status     show applied / pending / drifted migrations
  verify     run database integrity checks
  bootstrap  up, then verify (container/CI entrypoint)
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'up' && command !== 'status' && command !== 'verify' && command !== 'bootstrap') {
    throw new Error(USAGE);
  }
  const args: CliArgs = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--url') {
      const value = rest[i + 1];
      if (!value) throw new Error('--url requires a value');
      args.url = value;
      i += 1;
    } else if (token === '--pglite') {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        args.pglite = next;
        i += 1;
      } else {
        args.pglite = true;
      }
    } else if (token === '--applied-by') {
      const value = rest[i + 1];
      if (!value) throw new Error('--applied-by requires a value');
      args.appliedBy = value;
      i += 1;
    } else if (token === '--help' || token === '-h') {
      throw new Error(USAGE);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

export async function connect(args: CliArgs): Promise<DbClient> {
  if (args.pglite) {
    const dir = args.pglite === true ? 'memory://' : args.pglite;
    return PGliteClient.create(dir);
  }
  const url = args.url ?? getConfig().db.url;
  if (!url) {
    throw new Error('no database URL: pass --url, --pglite, or set DATABASE_URL');
  }
  const config = getConfig();
  return PgClient.create({
    connectionString: url,
    ssl: config.db.ssl,
    max: Math.min(config.db.poolMax, 4),
    applicationName: 'raja-migrate',
  });
}

export async function run(db: DbClient, args: CliArgs): Promise<number> {
  switch (args.command) {
    case 'up': {
      const result = await migrateUp(db, {
        ...(args.appliedBy ? { appliedBy: args.appliedBy } : {}),
        skipLock: Boolean(args.pglite),
        onProgress: (message) => console.log(`[migrate] ${message}`),
      });
      console.log(
        `[migrate] applied ${result.applied.length} migration(s), skipped ${result.skipped.length} in ${result.durationMs}ms`,
      );
      return 0;
    }
    case 'status': {
      const plan = await migrateStatus(db);
      console.log(`applied: ${plan.applied.length}`);
      for (const record of plan.applied) {
        console.log(`  ✓ ${record.name} (${record.applied_at}, ${record.duration_ms}ms, by ${record.applied_by})`);
      }
      console.log(`pending: ${plan.pending.length}`);
      for (const migration of plan.pending) {
        console.log(`  • ${migration.name}`);
      }
      if (plan.drifted.length > 0) {
        console.error('drifted migrations (checksum mismatch — refusing to continue):');
        for (const drift of plan.drifted) {
          console.error(`  ✗ ${drift.name} expected ${drift.expected.slice(0, 12)}… found ${drift.actual.slice(0, 12)}…`);
        }
        return 1;
      }
      return 0;
    }
    case 'verify': {
      const { results, ok } = await runIntegrityChecks(db);
      for (const result of results) {
        const mark = result.ok ? '✓' : '✗';
        console.log(`${mark} [${result.severity}] ${result.name}: ${result.detail}`);
      }
      console.log(ok ? '[verify] all checks passed' : '[verify] FAILED');
      return ok ? 0 : 1;
    }
    case 'bootstrap': {
      const result = await migrateUp(db, { skipLock: Boolean(args.pglite), onProgress: (m) => console.log(`[migrate] ${m}`) });
      console.log(`[bootstrap] applied ${result.applied.length} migration(s)`);
      const { results, ok } = await runIntegrityChecks(db);
      for (const check of results) {
        console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
      }
      return ok ? 0 : 1;
    }
    default:
      return 1;
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const db = await connect(args);
  try {
    process.exit(await run(db, args));
  } catch (error) {
    console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    await db.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
