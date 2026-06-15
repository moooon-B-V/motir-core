import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { activityService, ACTIVITY_PAGE_SIZE } from '@/lib/services/activityService';
import { workItemsService } from '@/lib/services/workItemsService';
import { estimationService } from '@/lib/services/estimationService';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ActivityEntryDto, ActivityEntryPartDto } from '@/lib/dto/activity';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { inngest } from '@/lib/jobs/client';

// Subtask 5.5.1 — the activity read service over the 1.4.6 revision trail.
// Real Postgres, no mocks: every history entry asserted here was produced by
// the SAME service writes production runs (create / update / status / sprint
// / links / archive), so the registry is exercised against the genuine diff
// shapes, not hand-rolled fixtures — except where a test deliberately injects
// a malformed / unknown / in-flight shape through the repository edge to
// prove the fallback contract.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  // Stub the Inngest publish: the status-transition paths now emit
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Insert a raw revision through the repository edge (the legit test reach). */
async function injectRevision(
  workItemId: string,
  changedById: string,
  changeKind: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await workItemRevisionsService.recordRevision(
      { workItemId, changedById, changeKind: changeKind as 'updated', diff },
      tx,
    );
  });
}

/** Bulk-inject suppressed position-noise revisions in one transaction. */
async function injectNoise(workItemId: string, changedById: string, count: number): Promise<void> {
  await db.$transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById,
          changeKind: 'updated',
          diff: { position: { from: `p${i}`, to: `p${i + 1}` } },
        },
        tx,
      );
    }
  });
}

function partsOf(entry: ActivityEntryDto | undefined): ActivityEntryPartDto[] {
  expect(entry).toBeDefined();
  return (entry as ActivityEntryDto).parts;
}

function fieldPart(entry: ActivityEntryDto | undefined, field: string): ActivityEntryPartDto {
  const part = partsOf(entry).find((p) => 'field' in p && p.field === field);
  expect(part, `expected a part for field '${field}'`).toBeDefined();
  return part as ActivityEntryPartDto;
}

async function createIssue(fx: WorkItemFixture, title = 'The issue') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

describe('activityService.listHistory — gating', () => {
  it('404s an unknown id and a cross-workspace id (finding #44)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLO' });
    const theirs = await createIssue(other);

    await expect(activityService.listHistory('nope', {}, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(activityService.listHistory(theirs.id, {}, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });
});

describe('activityService.listHistory — entry rendering', () => {
  it('renders the created anchor with the resolved actor', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0] as ActivityEntryDto;
    expect(entry.changeKind).toBe('created');
    expect(entry.parts).toEqual([{ kind: 'created' }]);
    expect(entry.actor.userId).toBe(fx.ownerId);
    expect(entry.actor.name).toBe(fx.owner.name);
  });

  it('renders scalar field edits, user fields, and dates from a real update', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await workItemsService.updateWorkItem(
      issue.id,
      {
        title: 'Renamed',
        priority: 'high',
        assigneeId: fx.ownerId,
        dueDate: '2026-07-01T00:00:00.000Z',
      },
      fx.ctx,
    );

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(2);
    const entry = page.entries[0]; // desc default — the update first

    expect(fieldPart(entry, 'title')).toEqual({
      kind: 'field',
      field: 'title',
      from: { type: 'text', text: 'The issue' },
      to: { type: 'text', text: 'Renamed' },
    });
    expect(fieldPart(entry, 'priority')).toMatchObject({
      from: { type: 'text', text: 'medium' },
      to: { type: 'text', text: 'high' },
    });
    expect(fieldPart(entry, 'assigneeId')).toEqual({
      kind: 'field',
      field: 'assigneeId',
      from: { type: 'none' },
      to: { type: 'user', userId: fx.ownerId, name: fx.owner.name, image: fx.owner.image },
    });
    expect(fieldPart(entry, 'dueDate')).toMatchObject({
      from: { type: 'none' },
      to: { type: 'date', date: '2026-07-01T00:00:00.000Z' },
    });
  });

  it('renders status transitions as workflow LABELS, not raw keys', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await workItemsService.updateStatus(issue.id, 'in_progress', fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(fieldPart(page.entries[0], 'status')).toEqual({
      kind: 'field',
      field: 'status',
      from: { type: 'status', key: 'todo', label: 'To Do' },
      to: { type: 'status', key: 'in_progress', label: 'In Progress' },
    });
  });

  it('renders a sprint move with the sprint NAME and suppresses the rank half (mixed diff)', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 4' }, fx.ctx);
    await backlogService.assignToSprint(issue.id, sprint.id, undefined, fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    const entry = page.entries[0];
    expect(fieldPart(entry, 'sprintId')).toEqual({
      kind: 'field',
      field: 'sprintId',
      from: { type: 'none' },
      to: { type: 'sprint', sprintId: sprint.id, name: 'Sprint 4' },
    });
    // The assignToSprint diff ALSO wrote backlogRank — suppressed, so the
    // entry renders partially: no backlogRank part anywhere.
    expect(partsOf(entry).some((p) => 'field' in p && p.field === 'backlogRank')).toBe(false);
  });

  it('renders link add/remove with the target identifier', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const blocker = await createIssue(fx, 'Blocker');
    const link = await workItemsService.linkWorkItems(
      { fromId: issue.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    let page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(partsOf(page.entries[0])).toEqual([
      {
        kind: 'link',
        op: 'added',
        linkKind: 'is_blocked_by',
        target: { type: 'issue', workItemId: blocker.id, identifier: blocker.identifier },
      },
    ]);

    await workItemsService.unlinkWorkItems(link.id, fx.ctx);
    page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(partsOf(page.entries[0])[0]).toMatchObject({ kind: 'link', op: 'removed' });
  });

  it('records description edits WITHOUT inlining the body', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const secret = 'the-body-text-that-must-never-render';
    await workItemsService.updateWorkItem(issue.id, { descriptionMd: secret }, fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(partsOf(page.entries[0])).toEqual([{ kind: 'fieldEdited', field: 'descriptionMd' }]);
    expect(JSON.stringify(page)).not.toContain(secret);
  });

  it('renders estimate changes and the archived anchor', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await estimationService.setEstimate(issue.id, 5, fx.ctx);
    await workItemsService.archiveWorkItem(issue.id, fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.entries[0]?.changeKind).toBe('archived');
    expect(partsOf(page.entries[0])).toEqual([{ kind: 'archived' }]);
    expect(fieldPart(page.entries[1], 'storyPoints')).toMatchObject({
      from: { type: 'none' },
      to: { type: 'text', text: '5' },
    });
  });

  it('renders the unarchived anchor (restore), symmetric with archive', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await workItemsService.archiveWorkItem(issue.id, fx.ctx);
    await workItemsService.unarchiveWorkItem(issue.id, fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.entries[0]?.changeKind).toBe('unarchived');
    expect(partsOf(page.entries[0])).toEqual([{ kind: 'unarchived' }]);
    // The archive entry is still present below it.
    expect(page.entries[1]?.changeKind).toBe('archived');
  });

  it('renders the in-flight comment_deleted shape (5.1.2) without content', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectRevision(issue.id, fx.ownerId, 'comment_deleted', {
      comment: {
        from: { commentId: 'cm_1', authorId: fx.ownerId, replyCount: 2 },
        to: null,
      },
    });

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.entries[0]?.changeKind).toBe('comment_deleted');
    expect(partsOf(page.entries[0])).toEqual([
      {
        kind: 'commentDeleted',
        author: { type: 'user', userId: fx.ownerId, name: fx.owner.name, image: fx.owner.image },
        replyCount: 2,
      },
    ]);
  });

  it('renders unknown keys via the generic fallback — never a crash, never a drop (mistake #29)', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectRevision(issue.id, fx.ownerId, 'updated', {
      frobnicate: { from: 1, to: 2 },
      weird: [1, 2, 3],
    });

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    // (jsonb re-orders keys by length — assert membership, not order)
    const parts = partsOf(page.entries[0]);
    expect(parts).toHaveLength(2);
    expect(parts).toContainEqual({ kind: 'generic', key: 'frobnicate', from: '1', to: '2' });
    expect(parts).toContainEqual({ kind: 'generic', key: 'weird', from: null, to: '[1,2,3]' });
  });

  it('renders registered prefix keys (customFields.*) and in-flight collections (labels)', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectRevision(issue.id, fx.ownerId, 'updated', {
      'customFields.severity': { from: null, to: 'Critical' },
      labels: { added: [{ name: 'backend' }, 'raw-string'] },
    });

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(fieldPart(page.entries[0], 'customFields.severity')).toMatchObject({
      kind: 'field',
      from: { type: 'none' },
      to: { type: 'text', text: 'Critical' },
    });
    expect(partsOf(page.entries[0])).toContainEqual({
      kind: 'collection',
      field: 'labels',
      op: 'added',
      items: ['backend', 'raw-string'],
    });
  });

  it('degrades deleted referents to stored-id fallbacks — never a crash', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectRevision(issue.id, fx.ownerId, 'updated', {
      assigneeId: { from: null, to: 'u_gone' },
      status: { from: 'todo', to: 'k_deleted_status' },
      sprintId: { from: null, to: 'sp_gone' },
      parentId: { from: null, to: 'wi_gone' },
    });

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    const entry = page.entries[0];
    expect(fieldPart(entry, 'assigneeId')).toMatchObject({
      to: { type: 'user', userId: 'u_gone', name: null, image: null },
    });
    expect(fieldPart(entry, 'status')).toMatchObject({
      to: { type: 'status', key: 'k_deleted_status', label: null },
    });
    expect(fieldPart(entry, 'sprintId')).toMatchObject({
      to: { type: 'sprint', sprintId: 'sp_gone', name: null },
    });
    expect(fieldPart(entry, 'parentId')).toMatchObject({
      to: { type: 'issue', workItemId: 'wi_gone', identifier: null },
    });
  });
});

describe('activityService.listHistory — noise policy', () => {
  it('suppresses pure backlogRank reorders from the feed AND the count; the trail keeps them', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const other = await createIssue(fx, 'Neighbour');
    // Leapfrog: each move lands AFTER the other's current rank, so every
    // step mints a strictly-new key — two guaranteed writes on `issue`.
    await backlogService.rankIssue(issue.id, { beforeId: other.id }, fx.ctx);
    await backlogService.rankIssue(other.id, { beforeId: issue.id }, fx.ctx);
    await backlogService.rankIssue(issue.id, { beforeId: other.id }, fx.ctx);

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(1); // the created anchor only
    expect(page.entries.map((e) => e.changeKind)).toEqual(['created']);

    // The trail itself still holds the suppressed rows (append-only audit).
    const raw = await db.workItemRevision.count({ where: { workItemId: issue.id } });
    expect(raw).toBe(3); // created + the two rank writes
  });

  it('excludes an empty-diff revision from feed and count', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectRevision(issue.id, fx.ownerId, 'updated', {});

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(1);
    expect(page.entries).toHaveLength(1);
  });
});

describe('activityService.listHistory — paging (finding #57)', () => {
  it('pages displayable entries by cursor with no loss or duplication, both orders', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    for (let i = 0; i < ACTIVITY_PAGE_SIZE + 5; i++) {
      await workItemsService.updateWorkItem(issue.id, { title: `Title ${i}` }, fx.ctx);
    }
    const expectedTotal = ACTIVITY_PAGE_SIZE + 6; // 25 updates + created

    const page1 = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page1.totalCount).toBe(expectedTotal);
    expect(page1.entries).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await activityService.listHistory(
      issue.id,
      { cursor: page1.nextCursor as string },
      fx.ctx,
    );
    expect(page2.entries).toHaveLength(expectedTotal - ACTIVITY_PAGE_SIZE);
    expect(page2.nextCursor).toBeNull();

    const ids = [...page1.entries, ...page2.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(expectedTotal); // no duplicates
    // desc: the very last entry is the created anchor…
    expect(page2.entries.at(-1)?.changeKind).toBe('created');

    // …and asc walks the same set from the other end.
    const asc1 = await activityService.listHistory(issue.id, { order: 'asc' }, fx.ctx);
    expect(asc1.entries[0]?.changeKind).toBe('created');
    const asc2 = await activityService.listHistory(
      issue.id,
      { order: 'asc', cursor: asc1.nextCursor as string },
      fx.ctx,
    );
    expect([...asc1.entries, ...asc2.entries].map((e) => e.id).sort()).toEqual([...ids].sort());
  });

  it('scans past suppressed noise within the bounded window', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const other = await createIssue(fx, 'Neighbour');
    // A stretch of rank-noise revisions burying 3 real edits: the two issues
    // leapfrog (each lands after the other's CURRENT rank), so every write
    // mints a genuinely new key and records a revision.
    await backlogService.rankIssue(issue.id, {}, fx.ctx);
    for (let i = 0; i < 15; i++) {
      await backlogService.rankIssue(other.id, { beforeId: issue.id }, fx.ctx);
      await backlogService.rankIssue(issue.id, { beforeId: other.id }, fx.ctx);
    }
    for (let i = 0; i < 3; i++) {
      await workItemsService.updateWorkItem(issue.id, { title: `Real ${i}` }, fx.ctx);
    }

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(4); // 3 edits + created
    expect(page.entries.map((e) => e.changeKind)).toEqual([
      'updated',
      'updated',
      'updated',
      'created',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('continues across repository batches when noise spans a whole batch', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await workItemsService.updateWorkItem(issue.id, { title: 'Real edit' }, fx.ctx);
    await injectNoise(issue.id, fx.ownerId, 23); // created + edit + 23 noise = 25 rows: 2 batches

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.totalCount).toBe(2);
    expect(page.entries.map((e) => e.changeKind)).toEqual(['updated', 'created']);
    expect(page.nextCursor).toBeNull();
  });

  it('caps a single call at the scan bound and resumes from the handed-back cursor', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectNoise(issue.id, fx.ownerId, 100); // newest 100 rows are pure noise

    // First call exhausts the 100-row scan window on noise alone: a short
    // (here empty) page with a continuation cursor, not an unbounded read.
    const page1 = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page1.totalCount).toBe(1);
    expect(page1.entries).toEqual([]);
    expect(page1.nextCursor).not.toBeNull();

    // "Show more" resumes and finds the created anchor beyond the noise.
    const page2 = await activityService.listHistory(
      issue.id,
      { cursor: page1.nextCursor as string },
      fx.ctx,
    );
    expect(page2.entries.map((e) => e.changeKind)).toEqual(['created']);
    expect(page2.nextCursor).toBeNull();

    // A cursor sitting exactly at the trail's end yields one empty final page.
    const created = page2.entries[0] as ActivityEntryDto;
    const page3 = await activityService.listHistory(issue.id, { cursor: created.id }, fx.ctx);
    expect(page3.entries).toEqual([]);
    expect(page3.nextCursor).toBeNull();
  });
});

describe('activityService.listHistory — batched resolution (no N+1)', () => {
  it('issues at most ONE lookup per display source for a mixed page', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const blocker = await createIssue(fx, 'Blocker');
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 9' }, fx.ctx);
    await workItemsService.updateStatus(issue.id, 'in_progress', fx.ctx);
    await backlogService.assignToSprint(issue.id, sprint.id, undefined, fx.ctx);
    await workItemsService.linkWorkItems(
      { fromId: issue.id, toId: blocker.id, kind: 'relates_to' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(issue.id, { assigneeId: fx.ownerId }, fx.ctx);

    const userSpy = vi.spyOn(userRepository, 'findByIds');
    const statusSpy = vi.spyOn(workflowsRepository, 'findStatuses');
    const sprintSpy = vi.spyOn(sprintRepository, 'findByIds');
    const issueSpy = vi.spyOn(workItemRepository, 'findByIds');
    const listSpy = vi.spyOn(workItemRevisionRepository, 'listByWorkItem');

    const page = await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(page.entries.length).toBeGreaterThanOrEqual(5);

    expect(userSpy).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(sprintSpy).toHaveBeenCalledTimes(1);
    expect(issueSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(1); // one bounded read for a short trail
  });

  it('skips lookups entirely for sources the page never references', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);

    const statusSpy = vi.spyOn(workflowsRepository, 'findStatuses');
    const sprintSpy = vi.spyOn(sprintRepository, 'findByIds');
    const issueSpy = vi.spyOn(workItemRepository, 'findByIds');

    await activityService.listHistory(issue.id, {}, fx.ctx);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(sprintSpy).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });
});

describe('read-only contract', () => {
  it('exposes no mutation surface: the service has only list methods', () => {
    // The append-only rule (verified Jira behaviour): nothing on the activity
    // service writes. A future method whose name implies mutation fails here.
    const methods = Object.keys(activityService);
    expect(methods).toEqual(['listHistory', 'listAll']);
    for (const m of methods) {
      expect(/^(create|update|delete|set|remove|edit)/i.test(m)).toBe(false);
    }
  });
});
