import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

const root = __dirname;

/** Workspace package aliases → source, so tests never depend on a prior build. */
const alias: Record<string, string> = {};
for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(resolve(root, group))) {
    alias[`@raja/${name}`] = resolve(root, group, name, 'src/index.ts');
  }
}

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      globals: false,
      include: ['packages/*/src/**/*.spec.ts', 'apps/*/src/**/*.spec.ts', 'packages/*/test/**/*.spec.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.spec.ts'],
      reporters: ['default'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      environment: 'node',
      globals: false,
      include: ['packages/*/test/**/*.int.spec.ts', 'apps/*/test/**/*.int.spec.ts', 'packages/*/src/**/*.int.spec.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      // Integration tests share a single PGlite instance per file: keep them sequential and
      // isolated per process so no two suites race on the same in-memory database.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
