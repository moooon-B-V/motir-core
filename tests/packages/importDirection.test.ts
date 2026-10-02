import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE PACKAGE IMPORT-DIRECTION GUARD (Story MOTIR-4292 · MOTIR-4299) —
// `docs/decisions/app-shell-over-packages.md` §1 rules 1–3, §3.
//
// Two directions, and they fail in opposite ways:
//
//   1. **No package imports the app.** An `@/…` specifier under `packages/*/src`
//      is the app leaking back into a context that is supposed to be
//      extractable. It is INVISIBLE to the naked eye because the alias reads
//      exactly like every other import in the repository, and it is invisible to
//      the type checker in the one place it matters — a package tsconfig with no
//      `paths` refuses it, but a `paths` entry added "to make the build work"
//      restores it silently, which is the edit this guard exists for.
//   2. **No app file reaches past a package's barrel.** `@motir/<pkg>/src/…`
//      resolves through the workspace symlink, so it works — and it makes the
//      package's export list a lie, because the surface a consumer can reach is
//      no longer the surface the package declares.
//
// Both predicates are ZERO across `design-system`, `cli`, `brand`,
// `orchestrator` and `pages`, so §3 records a property the repository has rather than a debt
// it intends to pay. This file is what keeps that true.
//
// Mould: `tests/ciFleet/orchestratorPortBoundary.test.ts` — the same source
// scan, the same comment stripping, the same mutation and innocence cases. It
// reads TEXT rather than a module graph for the reason that one does: the
// question is what a file SAYS, and a graph resolved through a workspace symlink
// answers a different one.

const PACKAGES_DIR = 'packages';
/** Roots that must reach a package only through its package NAME. */
const APP_ROOTS = ['lib', 'app', 'components'];

/** An `@/…` import — the app's own path alias — anywhere in a package's source. */
const APP_ALIAS = /\bfrom\s+['"]@\/[^'"]+['"]/;
/** A deep import past a package's barrel, from anywhere. */
const DEEP_PACKAGE_IMPORT = /\bfrom\s+['"]@motir\/[a-z][a-z0-9-]*\/(?!$)[^'"]+['"]/;

/**
 * Sanctioned exceptions — ONE file AND ONE tell each, with the reason.
 *
 * EMPTY, and it is a measurement: both predicates return zero today. It exists
 * so the NEXT case is argued for in a file rather than by widening a pattern,
 * and so an entry that stops matching fails the suite instead of quietly
 * excusing whatever moves into that file later (the last assertion below).
 */
const ALLOWED: ReadonlyArray<{ file: string; tell: RegExp; why: string }> = [];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    // `dist` is build output and `node_modules` is somebody else's code; neither
    // is source anybody edits, and both are full of bundled specifiers.
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const root = process.cwd();

/** Every package's `src` tree that exists right now — discovered, never listed. */
function packageSourceRoots(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, PACKAGES_DIR));
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(PACKAGES_DIR, name, 'src'))
    .filter((rel) => {
      try {
        return statSync(join(root, rel)).isDirectory();
      } catch {
        return false;
      }
    });
}

function violations(
  roots: readonly string[],
  tell: RegExp,
  what: string,
): Array<{ file: string; what: string; line: string }> {
  const found: Array<{ file: string; what: string; line: string }> = [];
  for (const scanRoot of roots) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file);
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const [index, line] of source.split('\n').entries()) {
        if (!tell.test(line)) continue;
        if (ALLOWED.some((a) => a.file === rel && a.tell.test(line))) continue;
        found.push({ file: `${rel}:${index + 1}`, what, line: line.trim().slice(0, 120) });
      }
    }
  }
  return found;
}

const message = (found: Array<{ file: string; what: string; line: string }>): string =>
  found.map((v) => `${v.file}: ${v.what}\n    ${v.line}`).join('\n');

describe('the app imports packages by name, and no package imports the app (MOTIR-4299)', () => {
  it('finds the package sources it is pointed at — the scan is not vacuous', () => {
    // A guard that walks nothing passes forever. Pin that every package this
    // repository has is actually being read.
    const roots = packageSourceRoots();
    expect(roots.length).toBeGreaterThanOrEqual(5);
    expect(roots).toContain(join('packages', 'orchestrator', 'src'));
    // MOTIR-5759: the pages package is scanned too, named so a rename or a
    // move out of `packages/` fails here rather than shrinking the scan.
    expect(roots).toContain(join('packages', 'pages', 'src'));
    expect(roots).toContain(join('packages', 'design-system', 'src'));
    expect(roots.flatMap((r) => walk(join(root, r))).length).toBeGreaterThan(50);
  });

  it('no `@/…` import appears under packages/*/src', () => {
    const found = violations(
      packageSourceRoots(),
      APP_ALIAS,
      'a package imports the APP (`@/…`) — invert it into a port the composition root binds',
    );
    expect(found, message(found)).toEqual([]);
  });

  it('no app file reaches past a package barrel into its sources', () => {
    const found = violations(
      APP_ROOTS,
      DEEP_PACKAGE_IMPORT,
      'a DEEP import past a package barrel — import the package by name',
    );
    expect(found, message(found)).toEqual([]);
  });

  it('and no PACKAGE reaches past another package’s barrel either', () => {
    // Rule 3, which the two assertions above do not cover between them: a
    // package deep-importing a sibling is the same defect one tier over, and it
    // is likelier, because the two live in the same tree.
    const found = violations(
      packageSourceRoots(),
      DEEP_PACKAGE_IMPORT,
      'a DEEP import into a sibling package — the barrel is the surface',
    );
    expect(found, message(found)).toEqual([]);
  });

  it('the guard actually detects both directions (mutation check)', () => {
    // ⚠️ A guard nobody has watched FAIL may be matching nothing. One planted
    // line per direction, in the exact shape each one takes.
    expect(APP_ALIAS.test("import { db } from '@/lib/db';")).toBe(true);
    expect(APP_ALIAS.test("import type { WorkItem } from '@/generated/prisma/client';")).toBe(true);
    expect(
      DEEP_PACKAGE_IMPORT.test(
        "import { flyOrchestrator } from '@motir/orchestrator/src/adapters/fly';",
      ),
    ).toBe(true);
    expect(
      DEEP_PACKAGE_IMPORT.test("import { Button } from '@motir/design-system/dist/index';"),
    ).toBe(true);
  });

  it('does not fire on the imports it deliberately permits', () => {
    // The innocence case, and it is load-bearing: a guard that fired on a
    // by-name package import or on a relative import inside a package would be
    // deleted within a week, and the boundary would then read enforced while
    // being enforced by nothing.
    const innocent = [
      "import { flyOrchestrator } from '@motir/orchestrator';",
      "import { Button } from '@motir/design-system';",
      "import { Decimal } from 'decimal.js';",
      "import type { ContainerHandle } from '../../types';",
      "import { isUnpriced } from './usage';",
    ];
    for (const line of innocent) {
      expect(APP_ALIAS.test(line), line).toBe(false);
      expect(DEEP_PACKAGE_IMPORT.test(line), line).toBe(false);
    }
    // …and the app's own `@/` imports are fine everywhere OUTSIDE a package,
    // which is why the first predicate is scoped to `packages/*/src` rather than
    // run over the tree.
    expect(APP_ROOTS).not.toContain(PACKAGES_DIR);
  });

  it('every sanctioned exception still points at a real file and a live tell', () => {
    // An allow-list entry that no longer matches anything is a hole nobody
    // notices. The list is empty today; this is what keeps the FIRST entry
    // honest.
    for (const allowed of ALLOWED) {
      const source = stripComments(readFileSync(join(root, allowed.file), 'utf8'));
      expect(allowed.tell.test(source), `${allowed.file} no longer contains ${allowed.tell}`).toBe(
        true,
      );
    }
  });
});

// ── `@motir/pages` enters the app through `lib/pages/` and `components/pages/` ──
//
// MOTIR-5758 held this block at ZERO app imports, because `ci.yml` let a
// pages-only change skip the app lanes. MOTIR-7276 added the first consumer —
// `lib/pages/index.ts`, the composition root — and removed that exemption in
// the same change, so the guard's successor is the ADR §2 boundary: the app
// reaches the package through its composition root (and the editor host under
// `components/pages/`), and everything else imports `@/lib/pages`.
describe('@motir/pages is imported only from lib/pages/ and components/pages/ (MOTIR-7276)', () => {
  const PAGES_IMPORT = /\bfrom\s+['"]@motir\/pages(?:\/[^'"]*)?['"]|\bimport\(\s*['"]@motir\/pages/;
  const SANCTIONED = [join('lib', 'pages') + '/', join('components', 'pages') + '/'];

  it('the classifier no longer exempts packages/pages from the app lanes', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toMatch(/^\s*packages\/pages\/\*\) ;;$/m);
  });

  it('finds `@motir/pages` imported nowhere else under lib/, app/, components/ or tests/', () => {
    const found = violations(
      [...APP_ROOTS, 'tests'],
      PAGES_IMPORT,
      'imports `@motir/pages` outside its composition root — import `@/lib/pages` instead',
    )
      .filter((v) => !v.file.startsWith(relative(root, __filename))) // this file's own samples
      .filter((v) => !SANCTIONED.some((dir) => v.file.startsWith(dir)));
    expect(found, message(found)).toEqual([]);
  });

  it('the composition root does import it — the boundary has a door', () => {
    const source = readFileSync(join(root, 'lib', 'pages', 'index.ts'), 'utf8');
    expect(PAGES_IMPORT.test(source)).toBe(true);
  });

  it('detects the import shapes it forbids, and not a sibling package', () => {
    expect(PAGES_IMPORT.test("import { planPlacement } from '@motir/pages';")).toBe(true);
    expect(PAGES_IMPORT.test("import type { PagePlacement } from '@motir/pages';")).toBe(true);
    expect(PAGES_IMPORT.test("const m = await import('@motir/pages');")).toBe(true);
    expect(PAGES_IMPORT.test("import { Button } from '@motir/design-system';")).toBe(false);
    expect(PAGES_IMPORT.test("import { x } from '@motir/pages-extra';")).toBe(false);
  });
});
