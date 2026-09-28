import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  InvalidObsolescenceError,
  ObsolescenceRequiresFinishedError,
} from '@/lib/workItems/errors';
import { toWorkItemSummaryDto } from '@/lib/mappers/workItemMappers';
import type { WorkItemKindDto, WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Story MOTIR-6574 · MOTIR-6579 — the work-item OBSOLESCENCE mark and note,
// driven through workItemsService against a REAL Postgres. Pins the service
// contract every later door (REST, MCP, the filter) writes through:
//   • persisted on EVERY kind, null when omitted, carried on the DTO;
//   • written on a `done` / `cancelled` card without touching its status or
//     `archivedAt` — marking finished work is the field's purpose — and, since
//     MOTIR-6575 · MOTIR-6672, ONLY there: a mark on an unfinished card is
//     OBSOLESCENCE_REQUIRES_FINISHED, on create and update alike (the rest of
//     that rule is `obsolescenceFinishedRule.test.ts`);
//   • an unknown value refused with INVALID_OBSOLESCENCE, writing nothing;
//   • every change recorded as a revision cell, a re-send recording nothing.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

async function revisionDiffs(workItemId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
    select: { diff: true },
  });
  return rows.map((r) => r.diff as Record<string, unknown>);
}

async function readRow(fx: WorkItemFixture, id: string) {
  return withWorkspaceServiceContext(fx.workspaceId, (tx) => workItemRepository.findById(id, tx));
}

/**
 * Create one item of `kind`, giving a subtask the story parent it needs. A mark in
 * `extra` is applied the only way it may be since MOTIR-6672: the card is moved to
 * `done` first, then marked through the service.
 */
async function createOf(
  fx: WorkItemFixture,
  kind: WorkItemKindDto,
  extra: { obsolescence?: WorkItemObsolescenceDto | null; obsolescenceNoteMd?: string | null } = {},
) {
  const { obsolescence, obsolescenceNoteMd } = extra;
  const item = await createUnmarked(fx, kind);
  if (obsolescence == null && obsolescenceNoteMd === undefined) return item;
  return markFinished(fx, item.id, obsolescence ?? null, obsolescenceNoteMd);
}

/** Move a card to `done` behind the service's back, then mark it through the service. */
async function markFinished(
  fx: WorkItemFixture,
  id: string,
  obsolescence: WorkItemObsolescenceDto | null,
  obsolescenceNoteMd?: string | null,
) {
  await adminDb.workItem.update({ where: { id }, data: { status: 'done' } });
  return workItemsService.updateWorkItem(
    id,
    { obsolescence, ...(obsolescenceNoteMd !== undefined ? { obsolescenceNoteMd } : {}) },
    fx.ctx,
  );
}

async function createUnmarked(fx: WorkItemFixture, kind: WorkItemKindDto) {
  const parent =
    kind === 'subtask'
      ? await workItemsService.createWorkItem(
          { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
          fx.ctx,
        )
      : null;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title: `A ${kind}`,
      ...(parent ? { parentId: parent.id } : {}),
    },
    fx.ctx,
  );
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('createWorkItem — obsolescence', () => {
  it.each(['epic', 'story', 'task', 'bug', 'subtask'] as const)(
    'refuses a mark on a new %s — it lands at the unfinished initial status — and writes nothing',
    async (kind) => {
      const fx = await makeWorkItemFixture();
      const parent =
        kind === 'subtask'
          ? await workItemsService.createWorkItem(
              { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
              fx.ctx,
            )
          : null;
      const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
      await expect(
        workItemsService.createWorkItem(
          {
            projectId: fx.projectId,
            kind,
            title: `A ${kind}`,
            ...(parent ? { parentId: parent.id } : {}),
            obsolescence: 'deprecated',
            obsolescenceNoteMd: 'Superseded by the **new** flow.',
          },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(ObsolescenceRequiresFinishedError);
      expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    },
  );

  it('accepts a NOTE alone on create — only the mark needs a finished card', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Noted',
        obsolescence: null,
        obsolescenceNoteMd: 'A note on its own.',
      },
      fx.ctx,
    );
    expect(task.obsolescence).toBeNull();
    expect(task.obsolescenceNoteMd).toBe('A note on its own.');
  });

  it('persists NULL when omitted — and records no cell', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createOf(fx, 'task');
    expect(task.obsolescence).toBeNull();
    expect(task.obsolescenceNoteMd).toBeNull();
    const row = await readRow(fx, task.id);
    expect(row?.obsolescence).toBeNull();
    expect(row?.obsolescenceNoteMd).toBeNull();
    const [created] = await revisionDiffs(task.id);
    expect(created).not.toHaveProperty('obsolescence');
    expect(created).not.toHaveProperty('obsolescenceNoteMd');
  });

  it('refuses a value outside the enum with INVALID_OBSOLESCENCE and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Bad mark',
          obsolescence: 'obsolete' as unknown as WorkItemObsolescenceDto,
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidObsolescenceError);
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('updateWorkItem — obsolescence on a finished card', () => {
  it.each(['epic', 'story', 'task', 'bug', 'subtask'] as const)(
    'persists the mark and note on a finished %s and returns them on the DTO',
    async (kind) => {
      const fx = await makeWorkItemFixture();
      const item = await createOf(fx, kind, {
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Superseded by the **new** flow.',
      });
      expect(item.obsolescence).toBe('deprecated');
      expect(item.obsolescenceNoteMd).toBe('Superseded by the **new** flow.');

      const row = await readRow(fx, item.id);
      expect(row?.obsolescence).toBe('deprecated');
      expect(row?.obsolescenceNoteMd).toBe('Superseded by the **new** flow.');
      // The marking revision records both values.
      const marked = (await revisionDiffs(item.id)).at(-1);
      expect(marked?.['obsolescence']).toEqual({ from: null, to: 'deprecated' });
      expect(marked?.['obsolescenceNoteMd']).toEqual({
        from: null,
        to: 'Superseded by the **new** flow.',
      });
    },
  );

  it.each([
    ['story', 'done'],
    ['task', 'cancelled'],
  ] as const)(
    'marks a %s in `%s` outdated with a note, changing neither status nor archivedAt',
    async (kind, status) => {
      const fx = await makeWorkItemFixture();
      const item = await createOf(fx, kind);
      await adminDb.workItem.update({ where: { id: item.id }, data: { status } });

      const updated = await workItemsService.updateWorkItem(
        item.id,
        { obsolescence: 'outdated', obsolescenceNoteMd: 'The flow was rewritten.' },
        fx.ctx,
      );
      expect(updated.obsolescence).toBe('outdated');
      expect(updated.obsolescenceNoteMd).toBe('The flow was rewritten.');
      expect(updated.status).toBe(status);
      expect(updated.archivedAt).toBeNull();

      const row = await readRow(fx, item.id);
      expect(row?.status).toBe(status);
      expect(row?.archivedAt).toBeNull();
      expect(row?.obsolescence).toBe('outdated');
    },
  );

  it('clears the mark with null', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createOf(fx, 'task', { obsolescence: 'deprecated' });
    const cleared = await workItemsService.updateWorkItem(task.id, { obsolescence: null }, fx.ctx);
    expect(cleared.obsolescence).toBeNull();
    expect((await readRow(fx, task.id))?.obsolescence).toBeNull();
    expect((await revisionDiffs(task.id)).at(-1)).toEqual({
      obsolescence: { from: 'deprecated', to: null },
    });
  });

  it('accepts the write on an ARCHIVED finished card, leaving it archived', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createOf(fx, 'task');
    const archivedAt = new Date('2026-09-01T00:00:00.000Z');
    await adminDb.workItem.update({
      where: { id: task.id },
      data: { archivedAt, status: 'done' },
    });

    const updated = await workItemsService.updateWorkItem(
      task.id,
      { obsolescence: 'deprecated', obsolescenceNoteMd: 'Replaced.' },
      fx.ctx,
    );
    expect(updated.obsolescence).toBe('deprecated');
    expect(updated.archivedAt).toBe(archivedAt.toISOString());
    const row = await readRow(fx, task.id);
    expect(row?.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
    expect(row?.obsolescenceNoteMd).toBe('Replaced.');
  });

  it('refuses a value outside the enum with INVALID_OBSOLESCENCE and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createOf(fx, 'task');
    const before = await revisionDiffs(task.id);
    await expect(
      workItemsService.updateWorkItem(
        task.id,
        {
          obsolescence: 'superseded' as unknown as WorkItemObsolescenceDto,
          obsolescenceNoteMd: 'Must not land.',
        },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OBSOLESCENCE' });
    const row = await readRow(fx, task.id);
    expect(row?.obsolescence).toBeNull();
    expect(row?.obsolescenceNoteMd).toBeNull();
    expect(await revisionDiffs(task.id)).toHaveLength(before.length);
  });
});

describe('updateWorkItem — obsolescence in the activity feed', () => {
  it('records null → outdated as ONE revision cell, and a re-send records nothing', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createOf(fx, 'task');
    await adminDb.workItem.update({ where: { id: task.id }, data: { status: 'done' } });

    await workItemsService.updateWorkItem(task.id, { obsolescence: 'outdated' }, fx.ctx);
    let diffs = await revisionDiffs(task.id);
    expect(diffs).toHaveLength(2);
    expect(diffs[1]).toEqual({ obsolescence: { from: null, to: 'outdated' } });

    await workItemsService.updateWorkItem(
      task.id,
      { obsolescenceNoteMd: 'Why it is outdated.' },
      fx.ctx,
    );
    diffs = await revisionDiffs(task.id);
    expect(diffs).toHaveLength(3);
    expect(diffs[2]).toEqual({
      obsolescenceNoteMd: { from: null, to: 'Why it is outdated.' },
    });

    // Re-sending the current values is not a change.
    const same = await workItemsService.updateWorkItem(
      task.id,
      { obsolescence: 'outdated', obsolescenceNoteMd: 'Why it is outdated.' },
      fx.ctx,
    );
    expect(same.obsolescence).toBe('outdated');
    expect(await revisionDiffs(task.id)).toHaveLength(3);
  });
});

describe('reads carry the mark', () => {
  it('a marked child reads as marked from its parent’s summary rows and the list read', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createOf(fx, 'story');
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Marked child', parentId: story.id },
      fx.ctx,
    );
    const child = await markFinished(fx, created.id, 'deprecated', 'Gone.');

    const children = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findChildren(story.id, tx),
    );
    expect(children.map(toWorkItemSummaryDto)).toEqual([
      expect.objectContaining({
        id: child.id,
        obsolescence: 'deprecated',
        obsolescenceNoteMd: 'Gone.',
      }),
    ]);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findProjectIssuesFlat(
        fx.projectId,
        fx.workspaceId,
        { column: 'key', direction: 'asc' },
        {},
        undefined,
        tx,
      ),
    );
    expect(rows.length).toBe(2);
    const listed = rows.find((r) => r.id === child.id);
    expect(listed?.obsolescence).toBe('deprecated');
    expect(listed?.obsolescenceNoteMd).toBe('Gone.');
    expect(rows.find((r) => r.id === story.id)?.obsolescence).toBeNull();
  });

  it('every list-shaped raw read projects both columns — forest, keyset, tree level, archived', async () => {
    const fx = await makeWorkItemFixture();
    // The child first: new work under a MARKED story is refused (MOTIR-6672).
    const unmarkedStory = await createOf(fx, 'story');
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Marked child',
        parentId: unmarkedStory.id,
      },
      fx.ctx,
    );
    const child = await markFinished(fx, created.id, 'deprecated', 'Gone.');
    const story = await markFinished(fx, unmarkedStory.id, 'outdated');
    const archived = await createOf(fx, 'task', {
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Archived and superseded.',
    });
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const reads = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => ({
      // Both arms of the recursive CTE: the story is an anchor row, the child a recursive one.
      forest: await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId, {}, tx),
      keyset: await workItemRepository.findProjectIssuesKeyset(
        fx.projectId,
        fx.workspaceId,
        {},
        { limit: 10 },
        tx,
      ),
      level: await workItemRepository.findProjectTreeLevel(
        fx.projectId,
        fx.workspaceId,
        story.id,
        { column: 'key', direction: 'asc' },
        { take: 10, offset: 0 },
        null,
        tx,
      ),
      archive: await workItemRepository.findArchivedByProject(
        fx.projectId,
        fx.workspaceId,
        { limit: 10, offset: 0 },
        tx,
      ),
    }));

    const pick = (
      rows: Array<{ id: string; obsolescence: unknown; obsolescenceNoteMd: unknown }>,
      id: string,
    ) => {
      const row = rows.find((r) => r.id === id);
      return row && { obsolescence: row.obsolescence, obsolescenceNoteMd: row.obsolescenceNoteMd };
    };
    expect(pick(reads.forest, story.id)).toEqual({
      obsolescence: 'outdated',
      obsolescenceNoteMd: null,
    });
    expect(pick(reads.forest, child.id)).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Gone.',
    });
    expect(pick(reads.keyset, child.id)).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Gone.',
    });
    expect(pick(reads.level, child.id)).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Gone.',
    });
    expect(pick(reads.archive, archived.id)).toEqual({
      obsolescence: 'deprecated',
      obsolescenceNoteMd: 'Archived and superseded.',
    });
  });
});
