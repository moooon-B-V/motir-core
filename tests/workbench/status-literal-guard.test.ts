import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKBENCH_SURFACE,
  scanStatusLiterals,
  statusLiteralKey,
  type StatusLiteralSite,
} from './statusLiteralScan';

// The STATUS-KEY-LITERAL guard (Story MOTIR-4777 · MOTIR-4784).
//
// The scanner beside this file explains WHAT it looks for and why a category
// literal is not a violation. This file is where the tree is ruled on — and,
// just as importantly, where the scanner is made to FIRE, because a guard whose
// only evidence is an empty list passes identically when its predicate has
// stopped matching anything at all.
//
// ⚠️ THERE IS NO ALLOWLIST, and that is a decision. Its sibling
// `tests/work-items/status-write-guard.test.ts` has one because a status WRITE
// has legitimate exceptions — the reassign inside `deleteStatus` cannot call
// the seam. A status-key COMPARISON on this surface has none: every question
// the Workbench asks about a status is a question about its CATEGORY, and the
// answer is always reached through `statusKeysByCategory`. If a case ever
// genuinely needs a key, it needs a conversation first, and an empty table is
// what makes that conversation happen instead of a line being added quietly.

const REMEDY =
  'The Workbench partitions on `workflow_status.CATEGORY`, never on a status KEY ' +
  '(`design/workbench/design-notes.md`). Resolve the keys for the category you mean ' +
  'through `workflowsService.getStatusKeysByCategoryByProjects` — which is what ' +
  '`activeProjectScope` already hands every read as `statusKeysByCategory` — and ' +
  'filter on THAT. A literal here is correct on our own project, where the default ' +
  'status names happen to match, and silently wrong for the first customer who ' +
  'renames a column.';

describe('no Workbench predicate compares a status KEY to a literal', () => {
  it('finds none in the tree', () => {
    const sites = scanStatusLiterals();
    expect(
      sites.map((s) => `${s.file}:${s.line} — ${s.fn} compares status to '${s.key}' (${s.via})`),
      REMEDY,
    ).toEqual([]);
  });

  it('names a surface that exists — every entry, in both forms', () => {
    // The tightness half. A guard whose scanned set has rotted to paths that no
    // longer exist reports zero for the wrong reason, which is the exact shape
    // of a guard that has quietly stopped guarding.
    for (const entry of WORKBENCH_SURFACE) {
      expect(
        existsSync(join(process.cwd(), entry.path)),
        `${entry.path} is scanned and absent`,
      ).toBe(true);
    }
    expect(WORKBENCH_SURFACE.some((e) => e.only !== undefined)).toBe(true);
  });
});

// ── The scanner, exercised ──────────────────────────────────────────────────
// Against a fixture TREE rather than a string, because the thing being asserted
// is the whole walk — the surface list, the directory recursion and the symbol
// filter — not just the predicate.

function fixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'workbench-literal-'));
  for (const [rel, source] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function scan(files: Record<string, string>): StatusLiteralSite[] {
  const { root, cleanup } = fixture(files);
  try {
    return scanStatusLiterals(root);
  } finally {
    cleanup();
  }
}

describe('the scanner itself — it is RED against a deliberate violation', () => {
  it('fires on a Prisma equality filter', () => {
    const sites = scan({
      'lib/workbench/reads.ts': `export const where = { projectId, status: 'done' };\n`,
    });
    expect(sites.map((s) => `${s.key}:${s.via}`)).toEqual(['done:prisma-filter']);
  });

  it('fires on `in` / `notIn`, each literal separately', () => {
    const sites = scan({
      'lib/workbench/reads.ts':
        `export const a = { status: { in: ['done', 'cancelled'] } };\n` +
        `export const b = { status: { notIn: ['in_review'] } };\n`,
    });
    expect(sites.map((s) => s.key)).toEqual(['done', 'cancelled', 'in_review']);
  });

  it('fires on a comparison, in either operand order', () => {
    const sites = scan({
      'lib/workbench/rows.ts':
        `export const a = (r: { status: string }) => r.status === 'implemented';\n` +
        `export const b = (r: { status: string }) => 'blocked' !== r.status;\n`,
    });
    expect(sites.map((s) => s.key)).toEqual(['implemented', 'blocked']);
  });

  it('fires on a membership test against a status-ish collection', () => {
    const sites = scan({
      'lib/workbench/group.ts': `export const f = (statusKeys: Set<string>) => statusKeys.has('done');\n`,
    });
    expect(sites.map((s) => s.via)).toEqual(['membership']);
  });

  it('reaches a NESTED file, and reports the enclosing function by name', () => {
    const sites = scan({
      'lib/workbench/nested/deep.ts': `export function listFinished() {\n  return { status: 'done' };\n}\n`,
    });
    expect(sites[0]?.fn).toBe('listFinished');
    expect(sites[0]?.file).toBe('lib/workbench/nested/deep.ts');
    expect(statusLiteralKey(sites[0]!)).toBe('lib/workbench/nested/deep.ts::listFinished::done');
  });
});

describe('the scanner itself — the three legitimate shapes it must LEAVE ALONE', () => {
  it('does not fire on a CATEGORY slice, whose values are not status keys', () => {
    // The hard case, and the reason this is an AST walk rather than a grep:
    // `'in_progress'` and `'done'` are simultaneously default status KEYS and
    // two of the three `StatusCategoryDto` values. Here they are categories.
    expect(
      scan({
        'lib/workbench/slices.ts':
          `export const TODO = { notIn: ['in_progress', 'done'] };\n` +
          `export const DONE = { in: ['done'] };\n`,
      }),
    ).toEqual([]);
  });

  it('does not fire on `statusCategory`, which IS the axis', () => {
    expect(
      scan({
        'lib/workbench/rows.ts':
          `export const moving = (r: { statusCategory: string | null }) =>\n` +
          `  r.statusCategory === 'in_progress';\n`,
      }),
    ).toEqual([]);
  });

  it('does not fire on a status key reached THROUGH the category map', () => {
    expect(
      scan({
        'lib/workbench/scope.ts':
          `export const keys = (s: { statusKeysByCategory: Record<string, string[]> }) =>\n` +
          `  s.statusKeysByCategory.in_progress;\n` +
          `export const has = (set: Set<string>, r: { status: string }) => set.has(r.status);\n`,
      }),
    ).toEqual([]);
  });

  it('does not fire OUTSIDE the surface, however plainly the violation is written', () => {
    // The guard is a claim about the Workbench, not about the tree. `/items`
    // filtering on a chosen status key is that surface working correctly.
    expect(scan({ 'lib/items/reads.ts': `export const w = { status: 'done' };\n` })).toEqual([]);
  });

  it('honours the SYMBOL filter on a shared file', () => {
    // `workItemRepository.ts` holds the Workbench reads and eighty other things.
    // A key comparison in `countByStatus` is that method doing its job; one in a
    // `home*` function is this guard's subject.
    const shared = {
      'lib/repositories/workItemRepository.ts':
        `export const repo = {\n` +
        `  countByStatus() {\n    return { status: 'done' };\n  },\n` +
        `  homeFinished() {\n    return { status: 'cancelled' };\n  },\n` +
        `};\n`,
    };
    expect(scan(shared).map((s) => `${s.fn}:${s.key}`)).toEqual(['homeFinished:cancelled']);
  });
});
