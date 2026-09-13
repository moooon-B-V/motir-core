import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { encodeFilterParam, type FilterAst, type FilterCondition } from '@/lib/filters/ast';
import { foldersService } from '@/lib/services/foldersService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The FOLDER filter predicate (Story MOTIR-5309 · MOTIR-5376) on a REAL Postgres,
// through the shipped read paths:
//   · a condition matches the EFFECTIVE folder — the item's own, else its root
//     ancestor's — and a chosen folder includes every folder inside it;
//   · `is none of` includes unfiled items; the empty pair reads the effective folder;
//   · a deleted or cross-project folder id is a stale value: it matches nothing
//     and raises no error;
//   · one AST returns one membership from the list, the count and a saved filter.
//
// Fixture (the card's):
//   folders  Parked ▸ 2025, and Later
//   E  epic filed in 2025, with story S under it and subtask T under S
//   B  bug filed in Later
//   U  task filed nowhere

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
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

async function seed() {
  const fx = await makeWorkItemFixture();
  const folder = (name: string, parentFolderId: string | null = null) =>
    foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
  const parked = await folder('Parked');
  const y2025 = await folder('2025', parked.id);
  const later = await folder('Later');
  const E = await make(fx, 'epic', 'Old import');
  const S = await make(fx, 'story', 'Map legacy fields', E.id);
  const T = await make(fx, 'subtask', 'Field table', S.id);
  const B = await make(fx, 'bug', 'Stale export link');
  const U = await make(fx, 'task', 'Launch checklist');
  await foldersService.fileWorkItem(E.id, { folderId: y2025.id }, fx.ctx);
  await foldersService.fileWorkItem(B.id, { folderId: later.id }, fx.ctx);
  const byHandle = { E, S, T, B, U };
  const expand = (...handles: Array<keyof typeof byHandle>) =>
    handles.map((h) => byHandle[h].identifier).sort();
  return { fx, folders: { parked, y2025, later }, items: byHandle, expand };
}

async function list(fx: WorkItemFixture, ast: FilterAst): Promise<string[]> {
  const page = await workItemsService.getProjectIssuesList(
    fx.projectId,
    { sort: SORT, filter: { ast } },
    fx.ctx,
  );
  return page.items.map((item) => item.identifier).sort();
}

const and = (...conditions: FilterCondition[]): FilterAst => ({ combinator: 'and', conditions });
const or = (...conditions: FilterCondition[]): FilterAst => ({ combinator: 'or', conditions });

describe('folder conditions match the EFFECTIVE folder, sub-folders included', () => {
  it('is any of: a parent folder, a nested folder, a sibling folder', async () => {
    const s = await seed();
    const anyOf = (id: string) => and({ field: 'folder', operator: 'is_any_of', value: [id] });

    expect(await list(s.fx, anyOf(s.folders.parked.id))).toEqual(s.expand('E', 'S', 'T'));
    expect(await list(s.fx, anyOf(s.folders.y2025.id))).toEqual(s.expand('E', 'S', 'T'));
    expect(await list(s.fx, anyOf(s.folders.later.id))).toEqual(s.expand('B'));
    expect(
      await list(
        s.fx,
        and({
          field: 'folder',
          operator: 'is_any_of',
          value: [s.folders.later.id, s.folders.y2025.id],
        }),
      ),
    ).toEqual(s.expand('E', 'S', 'T', 'B'));
  });

  it('is none of includes the unfiled bucket; the empty pair reads presence', async () => {
    const s = await seed();

    expect(
      await list(
        s.fx,
        and({ field: 'folder', operator: 'is_none_of', value: [s.folders.parked.id] }),
      ),
    ).toEqual(s.expand('B', 'U'));
    expect(await list(s.fx, and({ field: 'folder', operator: 'is_empty', value: null }))).toEqual(
      s.expand('U'),
    );
    expect(
      await list(s.fx, and({ field: 'folder', operator: 'is_not_empty', value: null })),
    ).toEqual(s.expand('E', 'S', 'T', 'B'));
  });

  it('follows a move: taking the epic out of its folder takes its subtree out with it', async () => {
    const s = await seed();
    await foldersService.fileWorkItem(s.items.E.id, { folderId: null }, s.fx.ctx);

    expect(
      await list(
        s.fx,
        and({ field: 'folder', operator: 'is_any_of', value: [s.folders.parked.id] }),
      ),
    ).toEqual([]);
    expect(await list(s.fx, and({ field: 'folder', operator: 'is_empty', value: null }))).toEqual(
      s.expand('E', 'S', 'T', 'U'),
    );
  });
});

describe('stale folder ids match nothing and never error', () => {
  it('a deleted folder, under either list operator', async () => {
    const s = await seed();
    const gone = await foldersService.createFolder(
      { projectId: s.fx.projectId, parentFolderId: null, name: 'Gone' },
      s.fx.ctx,
    );
    await adminDb.folder.delete({ where: { id: gone.id } });

    expect(
      await list(s.fx, and({ field: 'folder', operator: 'is_any_of', value: [gone.id] })),
    ).toEqual([]);
    // Stale is not "none of everything": the negation matches nothing too.
    expect(
      await list(s.fx, and({ field: 'folder', operator: 'is_none_of', value: [gone.id] })),
    ).toEqual([]);
  });

  it('a folder of another project reads as stale', async () => {
    const s = await seed();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await foldersService.createFolder(
      { projectId: other.projectId, parentFolderId: null, name: 'Parked' },
      other.ctx,
    );

    expect(
      await list(s.fx, and({ field: 'folder', operator: 'is_any_of', value: [foreign.id] })),
    ).toEqual([]);
  });

  it('under OR, a stale folder row drops out while its sibling row still matches', async () => {
    const s = await seed();
    expect(
      await list(
        s.fx,
        or(
          { field: 'folder', operator: 'is_any_of', value: ['no-such-folder'] },
          { field: 'folder', operator: 'is_any_of', value: [s.folders.later.id] },
        ),
      ),
    ).toEqual(s.expand('B'));
  });
});

describe('a folder condition composes with a status condition', () => {
  it('intersects under all, and unites under any', async () => {
    const s = await seed();
    await adminDb.workItem.update({ where: { id: s.items.S.id }, data: { status: 'in_progress' } });
    const inProgress: FilterCondition = {
      field: 'status',
      operator: 'is_any_of',
      value: ['in_progress'],
    };

    expect(
      await list(
        s.fx,
        and({ field: 'folder', operator: 'is_any_of', value: [s.folders.parked.id] }, inProgress),
      ),
    ).toEqual(s.expand('S'));
    expect(
      await list(
        s.fx,
        or({ field: 'folder', operator: 'is_any_of', value: [s.folders.later.id] }, inProgress),
      ),
    ).toEqual(s.expand('B', 'S'));
  });
});

describe('one set, three reads', () => {
  it('is none of Parked returns the same membership from the list, the count and a saved filter', async () => {
    const s = await seed();
    const ast = and({ field: 'folder', operator: 'is_none_of', value: [s.folders.parked.id] });
    const expected = s.expand('B', 'U');

    expect(await list(s.fx, ast)).toEqual(expected);
    expect(
      await workItemsService.countProjectWorkItems(s.fx.projectId, { filter: { ast } }, s.fx.ctx),
    ).toBe(expected.length);

    const saved = await savedFiltersService.create(
      s.fx.projectIdentifier,
      { name: 'Not parked', visibility: 'private', filterParam: encodeFilterParam(ast) },
      s.fx.ctx,
    );
    const resolved = await savedFiltersService.resolve(s.fx.projectIdentifier, saved.id, s.fx.ctx);
    expect(resolved.ast).toEqual(ast);
    expect(await list(s.fx, resolved.ast!)).toEqual(expected);
  });
});
