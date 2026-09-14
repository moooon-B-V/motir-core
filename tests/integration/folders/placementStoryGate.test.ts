import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// The placement story's VITEST GATE (Story MOTIR-5309 · MOTIR-5379) on a REAL
// Postgres: the assembled behaviour of its cards, measured where they meet. Each
// card's own tests are the floor; this file adds the seams no single card can see
// and the guards a coverage percentage cannot. Nothing is stubbed.
//
// What the card asks this gate to prove, and where:
//   seams
//     filing → the page read (detail read ⇔ placement re-read)  → 'seam · filing → the page read'
//     move / delete a folder → the page read and the filter      → 'seam · folder structure changes'
//     the effective-folder rule, in TypeScript and in SQL        → 'seam · one rule, two implementations'
//     one Folder condition, every consumer of the grammar        → 'seam · one set'
//   guards
//     the roadmap still treats a filed epic as a root            → 'guard · the roadmap'
//     the public project: filed work visible, no folder leaks    → 'guard · the public project'
//   already guarded, cited rather than copied
//     boards, backlog, ready list and reports unchanged by filing:
//       tests/integration/folders/storyGate.test.ts › 'guard · filing is invisible to workflow reads'
//     MCP `get_work_item` carries no `placementFolder`:
//       tests/mcp/dependency-edges.test.ts (the DTO ⇔ tool-payload parity case)
//     the public contract unchanged: tests/api/public/contract-drift.test.ts

import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { backlogService } from '@/lib/services/backlogService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { encodeFilterEnvelope, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import type { AutomationRuleWithOwner } from '@/lib/repositories/automationRuleRepository';
import type { BoardProjectionDto } from '@/lib/dto/boards';
import type {
  WorkItemKindDto,
  WorkItemPlacementDto,
  WorkItemTreeNodeDto,
} from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SORT = { column: 'key', direction: 'asc' } as const;

function make(
  fx: WorkItemFixture,
  kind: WorkItemKindDto,
  title: string,
  parentId: string | null = null,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function file(fx: WorkItemFixture, workItemId: string, folderId: string | null) {
  return foldersService.fileWorkItem(workItemId, { folderId }, fx.ctx);
}

const and = (...conditions: FilterCondition[]): FilterAst => ({ combinator: 'and', conditions });
const anyOf = (folderId: string) =>
  and({ field: 'folder', operator: 'is_any_of', value: [folderId] });

/** The `/items` list's membership for an AST (or every item, without one). */
async function listIds(fx: WorkItemFixture, ast?: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    fx.projectId,
    { sort: SORT, filter: ast ? { ast } : undefined, pageSize: 100 },
    fx.ctx,
  );
  return page.items.map((item) => item.id).sort();
}

/** Where an item sits, reduced to ids and the path — what both page reads must agree on. */
function where(
  p: Pick<WorkItemPlacementDto, 'folderId' | 'parent' | 'ancestors' | 'placementFolder'>,
) {
  return {
    folderId: p.folderId,
    parentId: p.parent?.id ?? null,
    ancestorIds: p.ancestors.map((a) => a.id).sort(),
    folder: p.placementFolder
      ? {
          folderId: p.placementFolder.folderId,
          path: p.placementFolder.path,
          viaId: p.placementFolder.via?.id ?? null,
        }
      : null,
  };
}

/** The page's first render (`getIssueDetail`) and its re-read after a move
 * (`getWorkItemPlacement`), asserted equal — then the one answer. */
async function bothReads(fx: WorkItemFixture, item: { id: string; identifier: string }) {
  const [detail, placement] = await Promise.all([
    workItemsService.getIssueDetail(fx.projectId, item.identifier, fx.ctx),
    workItemsService.getWorkItemPlacement(fx.projectId, item.id, fx.ctx),
  ]);
  expect(where(detail)).toEqual(where(placement));
  return where(placement);
}

describe('seam · filing → the page read', () => {
  it('file into a folder, re-parent under a filed epic, file the epic out: both page reads agree at every step', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const y2025 = await folder(fx, '2025', parked.id);
    const epic = await make(fx, 'epic', 'Old import');
    const story = await make(fx, 'story', 'Map legacy fields', epic.id);
    const task = await make(fx, 'task', 'Tidy docs');
    await file(fx, epic.id, y2025.id);

    // fileWorkItem into a folder: filed directly, no parent, no inheritance.
    await file(fx, task.id, y2025.id);
    expect(await bothReads(fx, task)).toEqual({
      folderId: y2025.id,
      parentId: null,
      ancestorIds: [],
      folder: { folderId: y2025.id, path: ['Parked', '2025'], viaId: null },
    });

    // moveWorkItem under a story of the filed epic: the own folder clears, and the
    // effective folder is now the epic's, through the epic.
    await workItemsService.moveWorkItem(task.id, { newParentId: story.id }, fx.ctx);
    expect(await bothReads(fx, task)).toEqual({
      folderId: null,
      parentId: story.id,
      ancestorIds: [epic.id, story.id].sort(),
      folder: { folderId: y2025.id, path: ['Parked', '2025'], viaId: epic.id },
    });

    // fileWorkItem(null) on the root takes its whole subtree out with it.
    await file(fx, epic.id, null);
    expect(await bothReads(fx, epic)).toEqual({
      folderId: null,
      parentId: null,
      ancestorIds: [],
      folder: null,
    });
    expect((await bothReads(fx, task)).folder).toBeNull();
  });
});

describe('seam · folder structure changes → the page read and the filter', () => {
  it('moving Parked under Archive lengthens the page path and brings the item under Archive', async () => {
    const fx = await makeWorkItemFixture();
    const archive = await folder(fx, 'Archive');
    const parked = await folder(fx, 'Parked');
    const y2025 = await folder(fx, '2025', parked.id);
    const item = await make(fx, 'task', 'Filed task');
    await file(fx, item.id, y2025.id);
    expect(await listIds(fx, anyOf(archive.id))).toEqual([]);

    await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: parked.id, targetParentFolderId: archive.id },
      fx.ctx,
    );

    expect((await bothReads(fx, item)).folder).toEqual({
      folderId: y2025.id,
      path: ['Archive', 'Parked', '2025'],
      viaId: null,
    });
    expect(await listIds(fx, anyOf(archive.id))).toEqual([item.id]);
  });

  it('deleting 2025 moves its item up to Parked; a filter naming 2025 goes stale, matches nothing and does not throw', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const y2025 = await folder(fx, '2025', parked.id);
    const item = await make(fx, 'task', 'Filed task');
    await file(fx, item.id, y2025.id);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: y2025.id }, fx.ctx);

    expect((await bothReads(fx, item)).folder).toEqual({
      folderId: parked.id,
      path: ['Parked'],
      viaId: null,
    });
    expect(await listIds(fx, anyOf(y2025.id))).toEqual([]);
    expect(
      await workItemsService.countProjectWorkItems(
        fx.projectId,
        { filter: { ast: anyOf(y2025.id) } },
        fx.ctx,
      ),
    ).toBe(0);
    expect(await listIds(fx, anyOf(parked.id))).toEqual([item.id]);
  });
});

describe('seam · one rule, two implementations', () => {
  it('for every item, the page read’s effective folder is where the SQL filter places it', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const y2025 = await folder(fx, '2025', parked.id);
    const later = await folder(fx, 'Later');
    // A filed root with a subtree three levels deep (the deepest the tree allows).
    const epic = await make(fx, 'epic', 'Old import');
    const story = await make(fx, 'story', 'Map legacy fields', epic.id);
    const task = await make(fx, 'task', 'Field table', story.id);
    const subtask = await make(fx, 'subtask', 'Column map', task.id);
    // A filed root with one child, a root filed in a PARENT folder, and unfiled work.
    const bug = await make(fx, 'bug', 'Stale export link');
    const bugSub = await make(fx, 'subtask', 'Repro', bug.id);
    const parkedTask = await make(fx, 'task', 'Parked directly');
    const q3 = await make(fx, 'epic', 'Q3 launch');
    const q3Story = await make(fx, 'story', 'Pricing page', q3.id);
    const loose = await make(fx, 'task', 'Launch checklist');
    await file(fx, epic.id, y2025.id);
    await file(fx, bug.id, later.id);
    await file(fx, parkedTask.id, parked.id);

    const items = [epic, story, task, subtask, bug, bugSub, parkedTask, q3, q3Story, loose];
    const unfiled = new Set(
      await listIds(fx, and({ field: 'folder', operator: 'is_empty', value: null })),
    );
    const inFolder = new Map<string, Set<string>>();
    for (const f of [parked, y2025, later])
      inFolder.set(f.id, new Set(await listIds(fx, anyOf(f.id))));

    const verdicts = [];
    for (const item of items) {
      const placement = await workItemsService.getWorkItemPlacement(fx.projectId, item.id, fx.ctx);
      const effective = placement.placementFolder?.folderId ?? null;
      verdicts.push({
        item: item.title,
        pageSaysUnfiled: effective === null,
        sqlSaysUnfiled: unfiled.has(item.id),
        sqlMatchesItsFolder: effective === null ? null : inFolder.get(effective)!.has(item.id),
      });
    }
    for (const v of verdicts) {
      expect(v).toEqual({
        item: v.item,
        pageSaysUnfiled: v.sqlSaysUnfiled,
        sqlSaysUnfiled: v.sqlSaysUnfiled,
        sqlMatchesItsFolder: v.pageSaysUnfiled ? null : true,
      });
    }
    // The fixture is not vacuous: both halves of the rule are exercised.
    expect(
      verdicts
        .filter((v) => v.pageSaysUnfiled)
        .map((v) => v.item)
        .sort(),
    ).toEqual(['Launch checklist', 'Pricing page', 'Q3 launch']);
  });
});

describe('seam · one set, every consumer of the grammar', () => {
  it('Folder is none of [Parked] names the same items through the list, tree, count, board, backlog and an automation condition', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const y2025 = await folder(fx, '2025', parked.id);
    const later = await folder(fx, 'Later');
    const epic = await make(fx, 'epic', 'Old import');
    const story = await make(fx, 'story', 'Map legacy fields', epic.id);
    await make(fx, 'subtask', 'Field table', story.id);
    const bug = await make(fx, 'bug', 'Stale export link');
    const parkedTask = await make(fx, 'task', 'Parked directly');
    const q3 = await make(fx, 'epic', 'Q3 launch');
    await make(fx, 'story', 'Pricing page', q3.id);
    await make(fx, 'task', 'Launch checklist');
    await file(fx, epic.id, y2025.id);
    await file(fx, bug.id, later.id);
    await file(fx, parkedTask.id, parked.id);

    const ast = and({ field: 'folder', operator: 'is_none_of', value: [parked.id] });
    const listed = await listIds(fx, ast);
    const everything = await listIds(fx);
    // Not vacuous: the condition removes some items and keeps others.
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(everything.length);
    // A surface that shows only part of the project must show exactly that
    // part of the set.
    const withinSet = (ids: string[]) => ids.filter((id) => listed.includes(id)).sort();

    // The filtered tree: its MATCHED nodes (ancestors are retained unmatched).
    const matched: string[] = [];
    const walk = (nodes: WorkItemTreeNodeDto[]) => {
      for (const node of nodes) {
        if (node.matched) matched.push(node.id);
        walk(node.children);
      }
    };
    walk(await workItemsService.getProjectTree(fx.projectId, { ast }, fx.ctx));
    expect(matched.sort()).toEqual(listed);

    expect(
      await workItemsService.countProjectWorkItems(fx.projectId, { filter: { ast } }, fx.ctx),
    ).toBe(listed.length);

    const cards = (board: BoardProjectionDto) =>
      board.columns.flatMap((column) => column.cards.map((card) => card.id)).sort();
    const boardAll = cards(await boardsService.getBoard(fx.projectId, fx.ctx));
    expect(boardAll.length).toBeGreaterThan(0);
    expect(cards(await boardsService.getBoard(fx.projectId, fx.ctx, undefined, { ast }))).toEqual(
      withinSet(boardAll),
    );

    const backlogIds = async (filterAst?: FilterAst) =>
      (await backlogService.getBacklog(fx.projectId, { limit: 100, filterAst }, fx.ctx)).items
        .map((item) => item.id)
        .sort();
    const backlogAll = await backlogIds();
    expect(backlogAll.length).toBeGreaterThan(0);
    expect(await backlogIds(ast)).toEqual(withinSet(backlogAll));

    // An automation rule's condition, evaluated by the engine against each item.
    // Only the three columns `evaluateConditions` reads are real on this row.
    const rule = {
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      conditionAst: encodeFilterEnvelope(ast),
    } as unknown as AutomationRuleWithOwner;
    const fires: string[] = [];
    for (const workItemId of everything) {
      const matches = await automationEngineService.evaluateConditions(rule, {
        trigger: 'created',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId,
        eventId: `gate-${workItemId}`,
      });
      if (matches) fires.push(workItemId);
    }
    expect(fires.sort()).toEqual(listed);
  });
});

describe('guard · the roadmap treats a filed epic as a root', () => {
  it('the roots level lists a filed epic exactly as it listed it unfiled, and its children level is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, 'epic', 'Old import');
    await make(fx, 'story', 'Map legacy fields', epic.id);
    const q3 = await make(fx, 'epic', 'Q3 launch');
    const roots = () => workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx);
    const children = () => workItemsService.getProjectRoadmap(fx.projectId, epic.id, fx.ctx);

    const rootsBefore = await roots();
    const childrenBefore = await children();
    expect(rootsBefore.nodes.map((n) => n.id).sort()).toEqual([epic.id, q3.id].sort());
    expect(childrenBefore.nodes).toHaveLength(1);

    const parked = await folder(fx, 'Parked');
    await file(fx, epic.id, parked.id);

    expect(await roots()).toEqual(rootsBefore);
    expect(await children()).toEqual(childrenBefore);
  });
});

describe('guard · the public project, below its page', () => {
  // A folder name only the team has seen — it must never reach a public payload.
  const SECRET = 'Quarantine-Nightingale';
  const FOLDER_KEY = /"[^"]*folder[^"]*"\s*:/i;

  async function publicFixture() {
    const fx = await makeWorkItemFixture({ name: 'Open source' });
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
    const outer = await folder(fx, SECRET);
    const inner = await folder(fx, `${SECRET} inner`, outer.id);
    return { fx, outer, inner };
  }

  it('the roots level includes a filed epic and a filed bug, with no folder name and no folder key', async () => {
    const { fx, outer, inner } = await publicFixture();
    const epic = await make(fx, 'epic', 'Old import');
    await make(fx, 'story', 'Map legacy fields', epic.id);
    const bug = await make(fx, 'bug', 'Stale export link');
    const loose = await make(fx, 'task', 'Tidy docs');
    await file(fx, epic.id, inner.id);
    await file(fx, bug.id, outer.id);

    const level = await publicProjectsService.getProjectTreeLevel(fx.projectIdentifier, null, null);

    expect(level.rows.map((row) => row.id).sort()).toEqual([epic.id, bug.id, loose.id].sort());
    const wire = JSON.stringify(level);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toMatch(FOLDER_KEY);
  });

  it('a filed item’s public detail carries no parent and no folder key', async () => {
    const { fx, inner } = await publicFixture();
    const epic = await make(fx, 'epic', 'Old import');
    await file(fx, epic.id, inner.id);

    const detail = await publicProjectsService.getWorkItemDetail(
      fx.projectIdentifier,
      epic.identifier,
      null,
    );

    expect(detail.parent).toBeNull();
    const wire = JSON.stringify(detail);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toMatch(FOLDER_KEY);
  });
});
