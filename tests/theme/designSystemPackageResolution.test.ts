import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1530 — Consumer-resolution smoke (motir-core side).
//
// motir-core is one of the two consumers of the extracted `@motir/design-system`
// package (the other is `nextjs-prisma-vercel-starter`). Both resolve the SAME
// published package through the SAME `exports` map — motir-core via a
// `workspace:*` symlink, the starter via the npm-published tarball — so this
// test's assertions about the package's public entry points double as the guard
// for the distribution mechanism BOTH consumers depend on. (The starter's own
// in-repo resolution is additionally proven by its `typecheck` + `next build`
// CI jobs, which resolve the barrel types and the `@import` of the token CSS on
// every push — the "build/typecheck smoke" wired by MOTIR-1528.)
//
// This suite proves the package resolves + loads for a consumer; the CONTENT
// parity (tokens/registries match what motir-core's shipped surfaces expect)
// lives in designSystemParity.test.ts.

const PKG_DIR = join(process.cwd(), 'node_modules/@motir/design-system');

describe('@motir/design-system resolves as an installed dependency', () => {
  it('is installed under node_modules (the workspace dependency is linked)', () => {
    expect(existsSync(PKG_DIR)).toBe(true);
    // A workspace symlink resolves to the in-repo package source of truth.
    expect(existsSync(join(PKG_DIR, 'package.json'))).toBe(true);
  });

  it('publishes both public entry points through its `exports` map, each pointing at a real shipped file', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    expect(pkg.name).toBe('@motir/design-system');

    // `.` — the JS barrel (ESM `import` condition; this is an ESM-only package).
    const dot = pkg.exports['.'] as { import?: string };
    expect(dot.import).toBeDefined();
    expect(existsSync(join(PKG_DIR, dot.import!))).toBe(true);

    // `./theme.css` — the token-CSS subpath motir-core's globals.css `@import`s
    // and the starter's does too. The distribution mechanism = this string map.
    const themeCss = pkg.exports['./theme.css'] as string;
    expect(themeCss).toBe('./theme.css');
    expect(existsSync(join(PKG_DIR, themeCss))).toBe(true);
  });
});

describe('the barrel loads and exposes the frozen public API surface', () => {
  it('re-exports the three-axis registries, the apply API, the cn helper, and the primitives', async () => {
    // Resolved via the `import` condition — exactly how the app + the starter
    // pull it in. A broken barrel (e.g. the RSC-safe re-export rewrite failing)
    // would throw here.
    const ds = await import('@motir/design-system');

    // Registries (Axis 1/2/3 id lists + guards).
    expect(Array.isArray(ds.STYLE_IDS)).toBe(true);
    expect(Array.isArray(ds.PALETTE_IDS)).toBe(true);
    expect(Array.isArray(ds.TYPE_IDS)).toBe(true);
    expect(typeof ds.isPaletteId).toBe('function');

    // The theme-apply contract (registries → applied `[data-*]`).
    expect(typeof ds.resolveAxesToApplied).toBe('function');
    expect(typeof ds.buildThemeInitScript).toBe('function');

    // The classname helper + a representative primitive + the specimen.
    expect(typeof ds.cn).toBe('function');
    expect(ds.Button).toBeDefined();
    expect(ds.Card).toBeDefined();
    expect(typeof ds.TokensSpecimen).toBe('function');
  });
});

describe('motir-core consumes the package (no divergent in-repo copy)', () => {
  it('wires the token CSS in through the package export, not a hand-copied file', () => {
    const globals = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(globals).toContain("@import '@motir/design-system/theme.css'");
  });

  it('routes the `@/lib/theme/*` import surface at the package via a re-export shim', () => {
    // The ~500 `@/lib/theme/…` call sites kept resolving after extraction
    // because these shims forward to the package (MOTIR-1527). If a shim were
    // reverted to an inline copy, the two token sources would drift.
    for (const surface of ['palettes', 'styles', 'typography']) {
      const shim = readFileSync(join(process.cwd(), `lib/theme/${surface}.ts`), 'utf8');
      expect(shim, `lib/theme/${surface}.ts must re-export the package`).toContain(
        "export * from '@motir/design-system'",
      );
    }
  });

  it('resolves the theme.css export to the one package source of truth', () => {
    // The node_modules copy and the in-repo package file are the SAME file
    // (workspace symlink) — proof there is a single source, not a stale mirror.
    const viaNodeModules = realpathSync(join(PKG_DIR, 'theme.css'));
    const viaPackage = realpathSync(join(process.cwd(), 'packages/design-system/theme.css'));
    expect(viaNodeModules).toBe(viaPackage);
  });
});
