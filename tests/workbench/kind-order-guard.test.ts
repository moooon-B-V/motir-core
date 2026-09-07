import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkItemKind } from '@/generated/prisma/client';
import {
  HOME_KIND_SORT_ORDER,
  deriveKindSortOrder,
  homeOrderBy,
} from '@/lib/repositories/workItemRepository';
import { compareReadyRows } from '@/lib/services/workItemsService';
import { READY_KIND_RANK } from '@/lib/workItems/readyFilter';

// The KIND-ORDER guard (Story MOTIR-4850 · MOTIR-4852).
//
// ── What it exists to protect ───────────────────────────────────────────────
// The Workbench's three work tabs and `/ready` both claim to be "in ready
// order". Two lists that derive one order separately will disagree eventually,
// and they will disagree QUIETLY: nothing errors, one page just puts an epic
// above a subtask, and the reader has no way to tell which list is lying.
//
// So the rank has exactly one home — `READY_KIND_RANK` in
// `lib/workItems/readyFilter.ts` — and the Workbench reads it. But Prisma
// cannot ORDER BY a rank map: it can only sort the enum column, and Postgres
// sorts an enum by its DECLARATION order. `WorkItemKind` is declared
// `epic, story, task, bug, subtask`, which is the ready rank BACKWARDS, so
// `kind: 'desc'` is the right answer today.
//
// ⚠️ THAT COINCIDENCE IS THE WHOLE RISK. It is true of the schema as it stands
// and of nothing else: a sixth kind, or a re-declared enum, breaks it silently
// and in the direction nobody looks. `deriveKindSortOrder` therefore COMPUTES
// the direction from the two facts rather than hard-coding it, and this file is
// where the computation is ruled on.
//
// ── Why the derivation answers `null` instead of throwing ───────────────────
// A throw at module load would 500 the first screen after signing in. The
// derivation degrades to today's answer and this guard is what stops a wrong
// one reaching production — a pull request that re-declares the enum goes red
// here, which is exactly where the person who re-declared it is standing.

const KINDS = Object.keys(WorkItemKind) as (keyof typeof WorkItemKind)[];

/**
 * What Postgres would return for `ORDER BY kind <direction>` — the enum's
 * DECLARATION order, forwards or backwards. This is the fact the derivation is
 * about, restated independently so the guard is not the derivation checking
 * itself.
 */
function postgresKindOrder(direction: 'asc' | 'desc'): string[] {
  const declared = Object.keys(WorkItemKind);
  return direction === 'asc' ? declared : [...declared].reverse();
}

describe('the Workbench and the ready set share ONE kind rank', () => {
  it('derives a direction at all — a re-declared enum has no direction and fails HERE', () => {
    expect(
      deriveKindSortOrder(),
      'Neither `asc` nor `desc` over the declared `WorkItemKind` order reproduces ' +
        '`READY_KIND_RANK`. Postgres sorts an enum by DECLARATION order, so a Prisma ' +
        '`orderBy: { kind }` can only ever express the declaration order or its reverse. ' +
        'Either re-declare `enum WorkItemKind` in `prisma/schema.prisma` so it is the ' +
        'ready rank (forwards or backwards), or give the Workbench reads an explicit ' +
        'rank ordering that does not go through the enum column. Do NOT re-declare the ' +
        'rank next to the read — that is the drift this guard exists for.',
    ).not.toBeNull();
  });

  it('agrees with `compareReadyRows` for EVERY pair of kinds', () => {
    const order = postgresKindOrder(HOME_KIND_SORT_ORDER === 'asc' ? 'asc' : 'desc');
    const positionOnWorkbench = new Map(order.map((kind, i) => [kind, i]));

    // Every ordered pair, not a spot check: the failure this guard is for is one
    // pair inverting, and a five-member enum has twenty of them.
    for (const a of KINDS) {
      for (const b of KINDS) {
        if (a === b) continue;
        const workbench = Math.sign(positionOnWorkbench.get(a)! - positionOnWorkbench.get(b)!);
        const ready = Math.sign(
          compareReadyRows(
            { kind: a, priority: 'medium', key: 1 },
            { kind: b, priority: 'medium', key: 1 },
          ),
        );
        expect(
          workbench,
          `the Workbench and \`/ready\` disagree about ${a} vs ${b}: the Workbench puts ` +
            `${workbench < 0 ? a : b} first, \`compareReadyRows\` puts ${ready < 0 ? a : b} first`,
        ).toBe(ready);
      }
    }
  });

  it('fires when the rank is re-valued — the guard is not vacuous', () => {
    // SENSITIVITY. A guard whose only evidence is a green run passes identically
    // when its predicate has stopped matching anything, so make it FAIL: swap
    // two ranks and assert the derivation can no longer express the order.
    const scrambled = { ...READY_KIND_RANK, subtask: 4, epic: 0 };
    expect(deriveKindSortOrder(scrambled, Object.keys(WorkItemKind))).not.toBe(
      HOME_KIND_SORT_ORDER,
    );

    // A SIXTH kind declared in a position that KEEPS the enum a reverse of the
    // rank is still expressible — the guard is about the property, not about the
    // member count.
    expect(
      deriveKindSortOrder({ ...READY_KIND_RANK, initiative: 2.5 }, [
        'epic',
        'story',
        'initiative',
        'task',
        'bug',
        'subtask',
      ]),
    ).toBe('desc');
    // Declared one place over, it is not, and the derivation says so instead of
    // silently sorting `initiative` into the wrong band.
    expect(
      deriveKindSortOrder({ ...READY_KIND_RANK, initiative: 2.5 }, [
        'epic',
        'story',
        'task',
        'initiative',
        'bug',
        'subtask',
      ]),
    ).toBeNull();
  });

  it('puts the kind rank on the work tabs and leaves Recently finished on its clock', () => {
    // The discriminator is the AXIS, not the tab: `completedAt` is the finished
    // window's, and everything else is a work tab.
    expect(homeOrderBy('updatedAt')).toEqual([{ kind: HOME_KIND_SORT_ORDER }, { id: 'desc' }]);
    expect(homeOrderBy('completedAt')).toEqual([{ completedAt: 'desc' }, { id: 'desc' }]);

    // ⚠️ THE TIEBREAK IS LOAD-BEARING, not tidiness. Kind is a five-valued key,
    // so it leaves large ties; without a TOTAL key after it two adjacent offset
    // pages could repeat a row and drop another, and nothing would error. Under
    // the keyset this was the cursor's job.
    for (const orderBy of [homeOrderBy('updatedAt'), homeOrderBy('completedAt')]) {
      expect(orderBy.at(-1), 'the last key must be total').toEqual({ id: 'desc' });
    }
  });
});

// ── The two SCANS ───────────────────────────────────────────────────────────
// A guard over the code that EXISTS cannot see the line nobody has written yet,
// which is where the next re-declaration will be typed. These two read the tree.

const ROOT = path.resolve(__dirname, '../..');

/**
 * The file with its COMMENTS removed.
 *
 * ⚠️ Without this the scans below flag their own subject's obituary. A
 * retirement worth guarding is a retirement worth RECORDING — `lib/dto/home.ts`
 * explains what the `nextCursor` was and why it went, and three re-scoped suites
 * say which assertion each replaced — and a guard that forces those paragraphs
 * to be deleted is a guard that destroys the only explanation the next reader
 * gets. The scan is about the CODE.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('the kind rank has exactly ONE declaration', () => {
  it('is declared in `readyFilter.ts` and nowhere under `lib/services` or `lib/repositories`', () => {
    // The shape of a re-declaration: a map literal that assigns `subtask` the
    // first position. That is the tell whatever the map is called, and it is
    // what `git grep -n 'subtask.*0' lib/services lib/repositories` looks for
    // (MOTIR-4852's own criterion) with far less noise.
    const offenders = [...walk('lib/services'), ...walk('lib/repositories')]
      .map((file) => ({ file, text: code(readFileSync(path.join(ROOT, file), 'utf8')) }))
      .filter(({ text }) => /\bsubtask\s*:\s*0\b/.test(text))
      .map(({ file }) => file);

    expect(
      offenders,
      'The ready kind order is declared once, in `lib/workItems/readyFilter.ts` ' +
        '(`READY_KIND_RANK`). A second copy under `lib/services` or `lib/repositories` ' +
        'is the drift `kind-order-guard` exists for: two lists that both claim to be ' +
        '"in ready order" and derive it separately disagree silently.',
    ).toEqual([]);
  });

  it('fires on a synthetic re-declaration — the scan is not vacuous', () => {
    expect(/\bsubtask\s*:\s*0\b/.test('const RANK = { subtask: 0, bug: 1 };')).toBe(true);
    // And it does NOT fire on the legitimate neighbours: a story-point value, a
    // count, a `subtask` key carrying anything else.
    expect(/\bsubtask\s*:\s*0\b/.test('const counts = { subtask: 0 + n };')).toBe(true);
    expect(/\bsubtask\s*:\s*0\b/.test("const kinds = { subtask: 'subtask' };")).toBe(false);
  });
});

describe('the retired keyset path stays retired', () => {
  // MOTIR-4852 deleted `lib/workbench/cursor.ts` and its helpers. An abandoned
  // read path does not sit quietly: it stays importable, keeps its tests green,
  // and the next person who needs paging on a neighbouring surface finds a
  // complete, tested, apparently-blessed helper and adopts the mechanism this
  // story decided against. The deletion is the deliverable; this keeps it.
  const RETIRED = [
    'workbench/cursor',
    'homeKeysetWhere',
    'HomeCursor',
    'WatchingCursor',
    'encodeHomeCursor',
    'decodeHomeCursor',
    'encodeWatchingCursor',
    'decodeWatchingCursor',
    'nextCursor',
  ] as const;

  it('names none of it anywhere on the Workbench SURFACE', () => {
    // ⚠️ SCOPED, and the scope is the point. `nextCursor` is a live word
    // elsewhere — the v1 pagination envelope and the MCP search cursor both use
    // it, correctly — so a tree-wide scan for it would be noise, and a guard
    // whose output is mostly noise is a guard people stop reading. The surface
    // is the one MOTIR-4852 changed.
    const files = [
      ...walk('app/(authed)/workbench'),
      ...walk('lib/workbench'),
      ...walk('tests/workbench'),
      ...walk('tests/integration/workbench'),
      'lib/services/homeService.ts',
      'lib/repositories/watcherRepository.ts',
      'lib/repositories/workItemRepository.ts',
      'lib/dto/home.ts',
    ];
    const hits: string[] = [];
    for (const file of files) {
      // This guard names every retired symbol, so it would match itself.
      if (file.endsWith('kind-order-guard.test.ts')) continue;
      const text = code(readFileSync(path.join(ROOT, file), 'utf8'));
      for (const name of RETIRED) if (text.includes(name)) hits.push(`${file}: ${name}`);
    }
    expect(
      hits,
      'The Workbench keyset was retired by MOTIR-4852. Paging is an OFFSET now — ' +
        '`{ items, total, page, pageSize }`, the shape `/items` already uses.',
    ).toEqual([]);
  });

  it('fires on a synthetic reference — the scan is not vacuous', () => {
    // SENSITIVITY, on the scan's own predicate rather than on the tree.
    const sample = "import { decodeHomeCursor } from '@/lib/workbench/cursor';";
    expect(RETIRED.filter((name) => sample.includes(name))).toEqual([
      'workbench/cursor',
      // `HomeCursor` matches too, as a SUBSTRING of `decodeHomeCursor` — which
      // is a property of the list, not an accident: every retired name is a
      // hit worth reporting, and a scan that tried to be clever about word
      // boundaries would miss `HomeCursor` written as a bare type reference.
      'HomeCursor',
      'decodeHomeCursor',
    ]);

    // And the comment strip is what keeps the tree's own retirement RECORD out
    // of the hits — asserted, because a silently over-eager strip would hide a
    // real reference too.
    expect(code('// a note about nextCursor\nconst x = 1;')).not.toContain('nextCursor');
    expect(code('const nextCursor = 1; // a note')).toContain('nextCursor');
  });

  it('the three retired MESSAGE keys are gone from BOTH catalogues, and unreferenced', () => {
    // ⚠️ THIS ASSERTION IS INVERTED FROM WHAT MOTIR-4852 WROTE HERE, and the
    // inversion is the point rather than a correction. That card left the keyset
    // MECHANISM behind while keeping the shipped two-link affordance, so
    // `workbench.pager.next` / `startOver` / `end` were still RENDERED and a
    // string removed while its consumer still calls for it renders the KEY to
    // the reader. MOTIR-4853 removed the markup, so the strings go with it — the
    // pair move together, in that order, which is what this test now pins.
    for (const locale of ['en', 'zh']) {
      const catalogue = JSON.parse(
        readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'),
      ) as { workbench: Record<string, unknown>; common: { pager?: Record<string, string> } };
      expect(
        catalogue.workbench['pager'],
        `${locale} still carries workbench.pager`,
      ).toBeUndefined();
      // And the control's strings have a HOME — a removal that left the pager
      // untranslated would satisfy the line above and be the worse outcome.
      expect(Object.keys(catalogue.common.pager ?? {}).sort(), `${locale} common.pager`).toEqual([
        'nextPage',
        'page',
        'pagination',
        'previousPage',
        'showing',
      ]);
    }
  });

  it('nothing on the Workbench SURFACE still references the retired keys', () => {
    // ⚠️ SCOPED TO THE SURFACE, because the KEY IS RELATIVE TO A NAMESPACE and a
    // bare `pager.next` is not unique in the tree. The first draft of this scan
    // read all of `app/` and `lib/`, and flagged
    // `app/(authed)/filters/_components/FiltersDirectory.tsx` — which calls
    // `useTranslations('savedFilters')` and is reading its OWN
    // `savedFilters.pager.next`, a legitimate and unrelated namespace. A guard
    // whose output is mostly noise is a guard people stop reading, so the scan
    // is narrowed to the files where `useTranslations('workbench')` is the
    // namespace in play. The catalogue assertion above is the tree-wide half.
    const hits: string[] = [];
    for (const file of [...walk('app/(authed)/workbench'), ...walk('lib/workbench')]) {
      const text = code(readFileSync(path.join(ROOT, file), 'utf8'));
      for (const key of ['pager.next', 'pager.startOver', 'pager.end'])
        if (text.includes(key)) hits.push(`${file}: ${key}`);
    }
    expect(
      hits,
      'A retired message key still has a caller — which renders the KEY to the reader ' +
        'rather than a string. The pager is `common.pager` now (MOTIR-4853).',
    ).toEqual([]);
  });
});
