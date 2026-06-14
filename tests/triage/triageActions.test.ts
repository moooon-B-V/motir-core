import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { commentsService } from '@/lib/services/commentsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { triageService } from '@/lib/services/triageService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import {
  NotInTriageError,
  TriageSelfMergeError,
  InvalidSnoozeUntilError,
} from '@/lib/triage/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Triage ACTIONS (Subtask 6.11.5, per docs/decisions/triage-model.md §4/§5):
// accept / promote (graduate → clear `triagedAt`), decline / mark-duplicate-
// merge (terminal cancel, KEEP `triagedAt`), snooze / unsnooze. Real Postgres
// (the standing rule). These lock the action post-states; 6.11.8 ships the
// broader parameterized read-set guard + permission matrix.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function createItem(
  fx: WorkItemFixture,
  opts: { kind?: 'task' | 'bug' | 'epic'; title?: string } = {},
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: opts.kind ?? 'task', title: opts.title ?? 'Item' },
    fx.ctx,
  );
}

/** Stand-in for the 6.11.4 intake path (not built yet): stamp the marker. */
async function markTriage(id: string, snoozedUntil: Date | null = null): Promise<void> {
  await db.workItem.update({ where: { id }, data: { triagedAt: new Date(), snoozedUntil } });
}

async function read(id: string) {
  const row = await db.workItem.findUniqueOrThrow({ where: { id } });
  return row;
}

async function treeIds(fx: WorkItemFixture): Promise<string[]> {
  return (await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId)).map(
    (r) => r.id,
  );
}

async function activeQueueIds(fx: WorkItemFixture): Promise<string[]> {
  return (
    await workItemRepository.findTriageQueue(fx.projectId, fx.workspaceId, { limit: 100 })
  ).map((r) => r.id);
}

describe('triageService.acceptTriageItem', () => {
  it('clears the marker, lands the item in the backlog with a fresh rank, and it enters the tree', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Crash on save' });
    await markTriage(item.id);
    expect(await treeIds(fx)).not.toContain(item.id);

    const dto = await triageService.acceptTriageItem(item.id, {}, fx.ctx);

    expect(dto.id).toBe(item.id);
    const row = await read(item.id);
    expect(row.triagedAt).toBeNull();
    expect(row.parentId).toBeNull();
    expect(row.sprintId).toBeNull();
    expect(row.backlogRank).not.toBeNull();
    expect(await treeIds(fx)).toContain(item.id);
    expect(await activeQueueIds(fx)).not.toContain(item.id);
  });

  it('records an optional comment on accept', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { title: 'Feature please' });
    await markTriage(item.id);

    await triageService.acceptTriageItem(item.id, { comment: 'Looks reasonable.' }, fx.ctx);

    const comments = await commentRepository.listThreadsByWorkItem(item.id);
    expect(comments.map((c) => c.bodyMd)).toContain('Looks reasonable.');
  });
});

describe('triageService.promoteTriageItem', () => {
  it('promotes under an epic parent (re-parents, positions, clears the marker)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createItem(fx, { kind: 'epic', title: 'Billing epic' });
    const bug = await createItem(fx, { kind: 'bug', title: 'Promote me' });
    await markTriage(bug.id);

    const dto = await triageService.promoteTriageItem(bug.id, { parentId: epic.id }, fx.ctx);

    expect(dto.parentId).toBe(epic.id);
    const row = await read(bug.id);
    expect(row.triagedAt).toBeNull();
    expect(row.parentId).toBe(epic.id);
    expect(row.position).not.toBeNull();
    expect(await treeIds(fx)).toContain(bug.id);
  });

  it('promotes into a sprint (sets sprintId, clears the marker)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);
    const task = await createItem(fx, { title: 'Sprint-bound' });
    await markTriage(task.id);

    await triageService.promoteTriageItem(task.id, { sprintId: sprint.id }, fx.ctx);

    const row = await read(task.id);
    expect(row.triagedAt).toBeNull();
    expect(row.sprintId).toBe(sprint.id);
  });

  it('rejects an illegal kind-parent target (a task cannot parent under a bug)', async () => {
    const fx = await makeWorkItemFixture();
    const bugParent = await createItem(fx, { kind: 'bug', title: 'Not a container' });
    const task = await createItem(fx, { kind: 'task', title: 'Orphan' });
    await markTriage(task.id);

    await expect(
      triageService.promoteTriageItem(task.id, { parentId: bugParent.id }, fx.ctx),
    ).rejects.toThrowError(); // IllegalParentTypeError from assertValidParent
    // The failed promotion left the marker intact (the tx rolled back).
    expect((await read(task.id)).triagedAt).not.toBeNull();
  });
});

describe('triageService.declineTriageItem', () => {
  it('cancels the item, KEEPS the marker, and keeps it out of the tree and the active queue', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Spam report' });
    await markTriage(item.id);

    const dto = await triageService.declineTriageItem(item.id, { comment: 'Not a bug.' }, fx.ctx);

    expect(dto.status).toBe('cancelled');
    const row = await read(item.id);
    expect(row.status).toBe('cancelled');
    expect(row.triagedAt).not.toBeNull(); // marker KEPT — never graduates
    expect(await treeIds(fx)).not.toContain(item.id);
    expect(await activeQueueIds(fx)).not.toContain(item.id); // terminal → out of active queue
    const comments = await commentRepository.listThreadsByWorkItem(item.id);
    expect(comments.map((c) => c.bodyMd)).toContain('Not a bug.');
  });
});

describe('triageService.markDuplicateTriageItem', () => {
  it('folds comments + attachments into the canonical item, links + cancels the duplicate, keeps the marker', async () => {
    const fx = await makeWorkItemFixture();
    const canonical = await createItem(fx, { kind: 'bug', title: 'Canonical bug' });
    const duplicate = await createItem(fx, { kind: 'bug', title: 'Same bug again' });
    await markTriage(duplicate.id);

    // Give the duplicate a comment + an attachment to fold.
    await commentsService.addComment(duplicate.id, { bodyMd: 'I hit this too' }, fx.ctx);
    await db.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ctx.userId,
        workItemId: duplicate.id,
        source: 'panel',
        blobUrl: 'https://blob.example/dup.png',
        mimeType: 'image/png',
        sizeBytes: 123,
        originalFilename: 'dup.png',
      },
    });

    const dto = await triageService.markDuplicateTriageItem(
      duplicate.id,
      { canonicalId: canonical.id },
      fx.ctx,
    );

    expect(dto.status).toBe('cancelled');
    const dupRow = await read(duplicate.id);
    expect(dupRow.status).toBe('cancelled');
    expect(dupRow.triagedAt).not.toBeNull();

    // Comments + attachments now hang off the canonical item.
    expect(await commentRepository.countByWorkItem(canonical.id)).toBe(1);
    expect(await commentRepository.countByWorkItem(duplicate.id)).toBe(0);
    expect(await attachmentRepository.countByWorkItem(canonical.id)).toBe(1);
    expect(await attachmentRepository.countByWorkItem(duplicate.id)).toBe(0);

    // A `duplicates` link from duplicate → canonical was recorded.
    const links = await workItemLinkRepository.findByFromItem(duplicate.id, 'duplicates');
    expect(links.map((l) => l.toId)).toContain(canonical.id);
  });

  it('rejects marking an item as a duplicate of itself', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Self' });
    await markTriage(item.id);
    await expect(
      triageService.markDuplicateTriageItem(item.id, { canonicalId: item.id }, fx.ctx),
    ).rejects.toBeInstanceOf(TriageSelfMergeError);
  });
});

describe('triageService snooze / unsnooze', () => {
  it('snooze removes the item from the active queue; unsnooze returns it', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Later' });
    await markTriage(item.id);
    expect(await activeQueueIds(fx)).toContain(item.id);

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await triageService.snoozeTriageItem(item.id, { snoozedUntil: until }, fx.ctx);
    expect((await read(item.id)).snoozedUntil).not.toBeNull();
    expect(await activeQueueIds(fx)).not.toContain(item.id);
    // Still hidden from every normal read while snoozed (marker stays set).
    expect(await treeIds(fx)).not.toContain(item.id);

    await triageService.unsnoozeTriageItem(item.id, fx.ctx);
    expect((await read(item.id)).snoozedUntil).toBeNull();
    expect(await activeQueueIds(fx)).toContain(item.id);
  });

  it('new activity (a comment) returns a snoozed item to the active queue', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Snoozed then poked' });
    await markTriage(item.id);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await triageService.snoozeTriageItem(item.id, { snoozedUntil: until }, fx.ctx);
    expect(await activeQueueIds(fx)).not.toContain(item.id);

    await commentsService.addComment(item.id, { bodyMd: 'Any update?' }, fx.ctx);

    expect((await read(item.id)).snoozedUntil).toBeNull();
    expect(await activeQueueIds(fx)).toContain(item.id);
  });

  it('rejects a snooze time in the past', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Bad snooze' });
    await markTriage(item.id);
    const past = new Date(Date.now() - 1000).toISOString();
    await expect(
      triageService.snoozeTriageItem(item.id, { snoozedUntil: past }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidSnoozeUntilError);
  });
});

describe('triage action guards', () => {
  it('rejects an action on an item that is not in triage (already graduated)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createItem(fx, { kind: 'bug', title: 'Already in tree' });
    // Never marked as triage → not in the queue.
    await expect(triageService.acceptTriageItem(item.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      NotInTriageError,
    );
    await expect(triageService.declineTriageItem(item.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      NotInTriageError,
    );
  });
});
