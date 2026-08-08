import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  chainsToModule,
  describeChains,
  resolveLocal,
  specifiersOf,
  DB_MODULE,
  REPO_ROOT,
} from './helpers/importGraph';

// MOTIR-2452 — the PUBLISHED DOCUMENTATION tree and its database reach.
//
// This is the half of MOTIR-2381's finding that card could not fix. It measured
// 340 of 348 traced functions carrying `@prisma/client` and attributed the docs
// tree to the root layout; removing the root layout's two imports took the count
// to 330 and the docs tree was NOT among the ten freed. There was a second,
// local cause: `app/(public)/docs/layout.tsx` called
// `projectTagsService.listCategories()` for six footer links, and that service
// imports `@/lib/db`, whose `PrismaClient` is constructed at module scope.
//
// Two DIFFERENT properties are asserted below, because measuring found they are
// not the same property — and conflating them is how this card would have shipped
// a false claim:
//
//   * NO DATABASE READ — nothing in this tree reaches `lib/db.ts`, the singleton
//     a query goes through. This card establishes it, and there is no approved
//     list: a documentation page that needs a query has a design problem, not a
//     missing allowlist entry.
//   * NO PRISMA CLIENT — nothing in this tree reaches the generated client at
//     all, for values OR enums. MOTIR-2452 did NOT establish it and pinned
//     exactly how far short it fell (three API-reference pages, reaching the
//     client for two enums one layer out in the v1 API surface); MOTIR-2458
//     removed that cause, so the allowlist below is now EMPTY and the second
//     test asserts the stronger property outright.
//
// ⚠️ These walk SOURCE, which is the cheap half of the answer; the authority is
// the build manifest (`next build && node scripts/measure-prisma-traces.mjs
// --list`), because a route also inherits its ROOT layout's closure. Measured
// across both cards: 342 of 350 before, 342 of 350 after — the root layout's
// approved imports reach every route, so the count cannot move here at all.
// With the root layout's two imports ALSO removed the same build measured 328 of
// 350 with four of the seven docs functions clean before MOTIR-2458, and all
// seven clean after. That arm is the evidence; the headline number is not, and
// MOTIR-2381 decided the root layout's reach deliberately.

const DOCS_ROOT = 'app/(public)/docs';
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** A runtime import of the Prisma client — generated re-export or the package. */
const PRISMA_SPECIFIER = /^@prisma\/client|^\.prisma\/|^@\/generated\/prisma/;

/**
 * The docs files still allowed to reach the generated Prisma client, and why.
 *
 * EMPTY, as of MOTIR-2458 — and that is the end state, not a starting one.
 *
 * It held the three API-reference pages, which reached the client for two
 * ENUMS: `lib/api/v1/ready/schema.ts` imported the generated `WorkItemKind` /
 * `WorkItemPriority` as runtime values to validate a query string, and the
 * OpenAPI registry pulls that file into every page rendering the reference.
 * MOTIR-2458 derived those value sets from the DTO unions the same file already
 * declares and moved the Prisma-parity assertion into
 * `tests/api/v1/ready-filter-vocabulary.test.ts`, where importing the client is
 * free. Nothing in this tree reaches the client any more.
 *
 * Shrinking this list was the only legal edit; it is now shrunk as far as it
 * goes. Growing it never was: a documentation page that acquires a database
 * client has a defect, and this is the assertion that says so.
 */
const PRISMA_CARRYING_DOCS_PAGES = [] as const satisfies readonly string[];

/** Every source file in the docs tree, repo-relative, sorted. */
function docsSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(relative(REPO_ROOT, full).split('\\').join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, DOCS_ROOT));
  return out.sort();
}

/** Whether `file`'s local import closure contains a runtime Prisma import. */
function reachesPrismaClient(file: string): boolean {
  const seen = new Set<string>([file]);
  const queue = [file];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of specifiersOf(readFileSync(join(REPO_ROOT, current), 'utf8'))) {
      if (PRISMA_SPECIFIER.test(specifier)) return true;
      const next = resolveLocal(specifier, current);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

describe('the published docs tree’s database reach (MOTIR-2452)', () => {
  it('finds the docs tree at all — a moved route must not silently pass this guard', () => {
    const sources = docsSources();
    expect(sources).toContain(`${DOCS_ROOT}/layout.tsx`);
    // The shell plus the pages it wraps. A guard that walks an empty directory
    // is green for the wrong reason, which is how this class of check rots.
    expect(sources.length).toBeGreaterThan(5);
  });

  it('no file under app/(public)/docs reaches lib/db.ts — no documentation page queries', () => {
    const offenders = docsSources().flatMap((file) =>
      chainsToModule(file).map((o) => ({ ...o, file })),
    );

    expect(
      offenders.map((o) => `${o.file} → ${o.specifier}`),
      offenders.length > 0
        ? `Published documentation must render without a database read. Reaching ${DB_MODULE}:\n` +
            describeChains(offenders) +
            `\nThe fix is to remove the read, not to allowlist it: these pages are ` +
            `read by anonymous strangers, and \`${DB_MODULE}\` constructs its client at ` +
            `module scope (so a traced route is an INSTANTIATED one). Re-measure with ` +
            `\`next build && node scripts/measure-prisma-traces.mjs --list\`.`
        : undefined,
    ).toEqual([]);
  });

  it('carries the generated Prisma client on NO page at all (MOTIR-2452 → MOTIR-2458)', () => {
    // MOTIR-2452 pinned this as an exact set of three so the number could only
    // go down and the follow-up would have a test that turned green when it
    // landed. MOTIR-2458 landed, so the expected set is now empty: no file in
    // the docs tree reaches the generated client, for values OR enums.
    const carrying = docsSources().filter((file) => reachesPrismaClient(file));

    expect(
      carrying,
      `Docs pages reaching the generated Prisma client.\nExpected NONE. An entry means a ` +
        `documentation page just grew a client it did not have — remove the import rather than ` +
        `widening PRISMA_CARRYING_DOCS_PAGES. Note that a generated ENUM is a runtime value: ` +
        `\`import { WorkItemKind } from '@/generated/prisma/client'\` ships the whole client, ` +
        `\`import type\` is erased and free (MOTIR-2458).`,
    ).toEqual([...PRISMA_CARRYING_DOCS_PAGES].sort());
  });

  it('the docs layout renders the footer without asking for topics', () => {
    // The specific regression this card fixes, pinned at its own altitude: the
    // layout passes an empty topic list rather than reading one. Stated as a
    // source assertion because the import — not the call — is what traces.
    expect(chainsToModule(`${DOCS_ROOT}/layout.tsx`).map((o) => o.specifier)).toEqual([]);
    expect(reachesPrismaClient(`${DOCS_ROOT}/layout.tsx`)).toBe(false);
  });
});
