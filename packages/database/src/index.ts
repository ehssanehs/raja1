/**
 * @raja/database — connection, migrations, tenant-scoped repositories.
 *
 * Layer rule (docs/architecture.md): this package may depend on `shared`, `config` and `crypto`
 * only. It must never import `auth`, `booking`, `billing` or an application.
 */
export * from './client';
export * from './scope';
export * from './repository';
export * from './migrate';
export * from './verify';
export { MIGRATIONS, type EmbeddedMigration } from './migrations';
