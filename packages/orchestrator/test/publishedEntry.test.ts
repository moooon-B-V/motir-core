import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// THE PUBLISHED ENTRY, LOADED BOTH WAYS (Story MOTIR-4292 · MOTIR-4299).
//
// ⚠️ THIS FILE EXISTS BECAUSE THE EXTRACTION SHIPPED AN ARTEFACT HALF ITS
// CONSUMERS COULD NOT LOAD, past a green type-check, a green Vitest run and a
// green build. `exports` declared only `types` + `import`, so:
//
//   * Next's bundler, Vite and `tsc` were all happy — every one of them
//     resolves through the `import` condition, and every one of them is a
//     BUILD-time resolver reading the source graph;
//   * Node's CommonJS loader answered `No "exports" main defined`.
//
// The consumer that hits the second path is the E2E harness:
// `tests/e2e/_helpers/job-registry.ts` is transpiled to CJS by Playwright and
// pulls `lib/jobs/registry` → `lib/orchestrator` → this package, so the barrel
// is `require`d. Eight specs died on the import, in a lane nothing else in the
// story runs (motir-core#2585).
//
// So the assertions below are about the ARTEFACT rather than the source: what
// the manifest promises, that the files it names exist, and that BOTH loaders
// return the same surface. The last one is the dual-build hazard — two formats
// are two chances for one of them to be stale or trimmed, and a consumer that
// takes the other path would see an export that "does not exist" with no
// compile error anywhere.
//
// Everything here reads `dist`, so it runs AFTER `pnpm build` — which is the
// order the `orchestrator` CI job already has (typecheck → build → test).

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, Record<string, string>>;
  main?: string;
  module?: string;
  types?: string;
};

// Node resolves a SELF-REFERENCE through the package's own `exports` map, which
// is the same code path a consumer takes — so this asks the loader the question
// the E2E harness asked, without reaching for the workspace symlink.
const require = createRequire(import.meta.url);

describe('the built barrel is loadable by every loader that reaches for it', () => {
  it('declares all three conditions — types, import AND require', () => {
    // The manifest half, checkable without a build: `require` missing is the
    // defect, and it is one line that no type checker can see.
    const root = manifest.exports['.'];
    expect(root, 'the package must export its barrel').toBeDefined();
    expect(Object.keys(root ?? {}).sort()).toEqual(['import', 'require', 'types']);
  });

  it('every path the manifest names exists in dist', () => {
    // A condition pointing at a file the build does not emit fails exactly like
    // a missing condition, one step later.
    for (const [condition, target] of Object.entries(manifest.exports['.'] ?? {})) {
      expect(existsSync(join(packageRoot, target)), `${condition} → ${target} is missing`).toBe(
        true,
      );
    }
    // …and the top-level fields, for a resolver that reads them instead.
    for (const field of ['main', 'module', 'types'] as const) {
      const target = manifest[field];
      expect(typeof target, `${field} must be declared`).toBe('string');
      expect(existsSync(join(packageRoot, target ?? '')), `${field} → ${target} is missing`).toBe(
        true,
      );
    }
  });

  it('`require()` returns the barrel — the assertion the E2E lane was making', () => {
    const barrel = require(manifest.name) as Record<string, unknown>;
    // The three shapes the app binds at its composition root. A bundle that
    // loaded but exported nothing would pass a bare "it did not throw".
    expect(typeof barrel.createUsageSink).toBe('function');
    expect(typeof barrel.buildContainerAccrual).toBe('function');
    expect(typeof barrel.flyFleetConfig).toBe('function');
    expect(barrel.FLEET_CONTAINER_SIZE).toBeTypeOf('object');
  });

  it('both formats expose the SAME surface', async () => {
    // The dual-build hazard. `format: ['esm', 'cjs']` is two emits from one
    // entry; if one goes stale the consumer on that path loses exports with no
    // error at the boundary — the failure surfaces as `undefined is not a
    // function` inside the app.
    const cjs = require(manifest.name) as Record<string, unknown>;
    const esm = (await import(manifest.name)) as Record<string, unknown>;
    const names = (m: Record<string, unknown>): string[] =>
      Object.keys(m)
        .filter((k) => k !== 'default' && k !== '__esModule')
        .sort();

    expect(names(cjs).length).toBeGreaterThan(20);
    expect(names(esm)).toEqual(names(cjs));
  });
});
