import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE PRISMA TYPE BOUNDARY (Story MOTIR-4292 · MOTIR-4296).
//
// `CLAUDE.md`'s 4-layer rule already says services do not QUERY. What it did not
// say — and what the type checker pays for — is that services and mappers also
// do not NAME the generated client's heavy generics. `Prisma.<Model>CreateInput`
// and its siblings are not model types: each one is a projection over a model's
// whole relation graph, and naming one outside the layer that owns the query
// instantiates that graph at a call site that has no business knowing it exists.
//
// So the rule is: **the generated client's payload and input generics are named
// only under `lib/repositories/**`.** A caller above that layer builds its write
// payload against a type the OWNING REPOSITORY exports (`WorkItemUpdateInput`,
// `PlanItemCreateInput`, …), which is the same type under a name that says which
// layer owns it — and which can be narrowed later without touching a caller.
//
// ── What this boundary deliberately does NOT restrict ───────────────────────
// Two things, because they are cheap and everywhere, and a guard that fired on
// them would be deleted — and a deleted guard is worse than none, because the
// boundary still reads enforced:
//
//   * **Model types and enums** — `import type { WorkItem, WorkItemKind } from
//     '@/generated/prisma/client'`. 333 files use them; they are one interface
//     each, not a projection.
//   * **`Prisma.TransactionClient`** — the `tx` parameter services thread down.
//     It is the whole point of the transaction rule one file over.
//
// Both are pinned by the innocence case below, so narrowing the guard onto them
// later fails a test rather than quietly changing what the rule means.
//
// Mould: `tests/ciFleet/orchestratorPortBoundary.test.ts` — the same
// source-scan shape, the same per-file-AND-per-tell exemption list, the same
// mutation and innocence cases. It scans SOURCE rather than a module graph for
// the same reason that one does: a graph says what is imported, and a namespace
// MEMBER is not an import.

/** Where the generated client's generics may be named. */
const OWNING_DIR = join('lib', 'repositories');

/** Roots that must stay on repository-exported types. */
const SCANNED_ROOTS = ['lib', 'app', 'components'];

/**
 * The tells: the generated client's PROJECTION types, each addressed through the
 * `Prisma` namespace.
 *
 * Deliberately anchored on `Prisma.<Model>` rather than on the suffix alone —
 * a repository-exported `WorkItemUpdateInput` is the shape this rule is moving
 * callers ONTO, so a pattern that matched the bare suffix would fire on the fix.
 */
const PRISMA_GENERIC_TELLS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  {
    pattern: /\bPrisma\.[A-Z][A-Za-z0-9]*GetPayload\b/,
    what: 'a generated payload projection (`Prisma.…GetPayload`)',
  },
  {
    pattern: /\bPrisma\.[A-Z][A-Za-z0-9]*(?:Unchecked)?(?:Create|Update)Input\b/,
    what: 'a generated write-input type (`Prisma.…Create/UpdateInput`)',
  },
  {
    pattern: /\bPrisma\.[A-Z][A-Za-z0-9]*Where(?:Unique)?Input\b/,
    what: 'a generated filter type (`Prisma.…WhereInput`)',
  },
  {
    pattern: /\bPrisma\.[A-Z][A-Za-z0-9]*(?:Select|Include)\b/,
    what: 'a generated projection selector (`Prisma.…Select` / `…Include`)',
  },
  {
    pattern: /\bPrisma\.[A-Z][A-Za-z0-9]*OrderBy[A-Za-z]*Input\b/,
    what: 'a generated ordering type (`Prisma.…OrderBy…Input`)',
  },
  {
    pattern:
      /\bPrisma\.[A-Z][A-Za-z0-9]*(?:FindMany|FindFirst|FindUnique|Create|Update|Delete|Upsert|Aggregate|GroupBy)Args\b/,
    what: 'a generated argument bag (`Prisma.…Args`)',
  },
];

/**
 * Sanctioned exceptions — ONE file AND ONE tell each, with the reason.
 *
 * EMPTY, and that is a measurement rather than an aspiration: the sweep that
 * landed this guard moved every site outside `lib/repositories/**` onto a
 * repository-exported alias, so there was nothing left to excuse. The list
 * survives because the NEXT legitimate case needs somewhere to be argued for
 * that is not "widen the tell" — and scoping an entry to one file and one
 * pattern is what stops it from excusing whatever moves into that file later.
 */
const ALLOWED: ReadonlyArray<{ file: string; tell: RegExp; why: string }> = [];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.tsx?$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

/** Strip line and block comments — a comment EXPLAINING the boundary (several
 *  of the swept files carry one, and so does this file) is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const root = process.cwd();

function violations(): Array<{ file: string; what: string; line: string }> {
  const found: Array<{ file: string; what: string; line: string }> = [];
  for (const scanRoot of SCANNED_ROOTS) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file);
      if (rel.startsWith(OWNING_DIR + sep)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, what } of PRISMA_GENERIC_TELLS) {
        for (const [index, line] of source.split('\n').entries()) {
          if (!pattern.test(line)) continue;
          if (ALLOWED.some((a) => a.file === rel && a.tell.test(line))) continue;
          found.push({ file: `${rel}:${index + 1}`, what, line: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return found;
}

describe('the generated client’s generics stay under lib/repositories (MOTIR-4296)', () => {
  it('finds files to scan at all — the walk is not vacuous', () => {
    // Without this the assertion below passes forever the day the walk breaks,
    // which is the failure mode a source-scan guard dies of.
    const scanned = SCANNED_ROOTS.flatMap((r) => walk(join(root, r)));
    expect(scanned.length).toBeGreaterThan(1500);
    expect(walk(join(root, OWNING_DIR)).length).toBeGreaterThan(50);
  });

  it('nothing in lib/, app/ or components/ names a Prisma generic outside the repository layer', () => {
    const found = violations();
    // The failure message IS the value: file, line and WHICH tell fired, so a
    // violation is fixed rather than merely reported.
    expect(found, found.map((v) => `${v.file}: ${v.what}\n    ${v.line}`).join('\n')).toEqual([]);
  });

  it('the guard actually detects a leak (mutation check)', () => {
    // ⚠️ A guard nobody has watched FAIL may be matching nothing. These are the
    // exact shapes the sweep removed, one per tell.
    const leaks = [
      'const x: Prisma.WorkItemCreateInput = {};',
      'const update: Prisma.WorkItemUncheckedUpdateInput = {};',
      'type Row = Prisma.WorkItemGetPayload<{ include: { children: true } }>;',
      'const where: Prisma.SprintWhereInput = {};',
      'const key: Prisma.ComponentWhereUniqueInput = { id };',
      'const include: Prisma.WorkItemInclude = { children: true };',
      'const select: Prisma.WorkItemSelect = { id: true };',
      'const order: Prisma.WorkItemOrderByWithRelationInput = { position: "asc" };',
      'const args: Prisma.WorkItemFindManyArgs = {};',
    ];
    for (const leak of leaks) {
      expect(
        PRISMA_GENERIC_TELLS.some(({ pattern }) => pattern.test(leak)),
        leak,
      ).toBe(true);
    }
  });

  it('does not fire on the two things it deliberately permits', () => {
    // The innocence case, and it is load-bearing: a guard that fired on a model
    // type or on `tx` would be deleted within a week, and the boundary would
    // then read enforced while being enforced by nothing.
    const innocent = [
      "import type { WorkItem, WorkItemKind } from '@/generated/prisma/client';",
      'async function f(tx: Prisma.TransactionClient) {}',
      'const total = new Prisma.Decimal(0);',
      'const sql = Prisma.join(parts);',
      'const patch: WorkItemUpdateInput = {};',
      'const data: PlanItemCreateInput = { planId };',
      "import { workItemRepository, type WorkItemUpdateInput } from '@/lib/repositories/workItemRepository';",
    ];
    for (const line of innocent) {
      expect(
        PRISMA_GENERIC_TELLS.some(({ pattern }) => pattern.test(stripComments(line))),
        line,
      ).toBe(false);
    }
  });

  it('every sanctioned exception still points at a real file and a live tell', () => {
    // An allow-list entry that no longer matches anything is a hole nobody
    // notices — it silently excuses whatever moves into that file next. The list
    // is empty today; this assertion is what keeps the FIRST entry honest.
    for (const allowed of ALLOWED) {
      const source = stripComments(readFileSync(join(root, allowed.file), 'utf8'));
      expect(allowed.tell.test(source), `${allowed.file} no longer contains ${allowed.tell}`).toBe(
        true,
      );
    }
  });

  it('the repository layer still names them — the boundary MOVED the types, it did not delete them', () => {
    // The mirror assertion, and the one that would catch a "fix" that satisfied
    // the guard by dropping the types altogether (or by moving the queries out
    // of the repositories). The generics belong SOMEWHERE, and this is where.
    const named = walk(join(root, OWNING_DIR)).filter((file) =>
      PRISMA_GENERIC_TELLS.some(({ pattern }) =>
        pattern.test(stripComments(readFileSync(file, 'utf8'))),
      ),
    );
    expect(named.length).toBeGreaterThan(20);
  });
});
