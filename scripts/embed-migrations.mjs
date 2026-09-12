#!/usr/bin/env node
/**
 * Embeds packages/database/src/migrations/*.sql into a TypeScript module so that migrations
 * travel with the compiled output (no runtime file-path assumptions in Docker images).
 *
 * Source of truth: the .sql files. Run: node scripts/embed-migrations.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'packages/database/src/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const entries = files.map((file) => {
  const sql = readFileSync(join(dir, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return { name: file.replace(/\.sql$/, ''), checksum, sql };
});

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: packages/database/src/migrations/*.sql
 * Regenerate: node scripts/embed-migrations.mjs
 */
export interface EmbeddedMigration {
  readonly name: string;
  readonly sql: string;
  /** sha256 of the SQL text; the runner refuses to run a migration whose checksum changed. */
  readonly checksum: string;
}

export const MIGRATIONS: readonly EmbeddedMigration[] = [
`;

const body = entries
  .map(
    (entry) => `  {
    name: ${JSON.stringify(entry.name)},
    checksum: ${JSON.stringify(entry.checksum)},
    sql: ${JSON.stringify(entry.sql)},
  },`,
  )
  .join('\n');

writeFileSync(join(dir, 'index.ts'), `${banner}${body}\n];\n`);
console.log(`embedded ${entries.length} migrations: ${entries.map((e) => e.name).join(', ')}`);
