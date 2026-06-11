import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  IllegalParentTypeError,
  ReporterNotInWorkspaceError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { CrossWorkspaceLinkError, WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { CreateWorkItemInput } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import {
  createTestProject,
  createTestUser,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { inngest } from '@/lib/jobs/client';

// Subtask 1.4.7 — the error-path + edge-branch coverage for workItemsService.
// The happy-path and concurrency behaviour lives in service.test.ts; this file
// drives the membership gates, the not-found rejections, the field-by-field
// update diff branches, the re-parent paths, the move no-op / not-found
// branches, the list filters, and the link/unlink not-found rejections. Every
// one is a real behaviour the route layer (Epic 2) maps to an HTTP status; the
// aggregate also lifts workItemsService above the 90% coverage gate. Real
// Postgres, no mocks.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  // Stub the Inngest publish: the status-transition paths now emit
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  await truncateAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

function createInput(
  fx: WorkItemFixture,
  over: Partial<CreateWorkItemInput> = {},
): CreateWorkItemInput {
  return { projectId: fx.projectId, kind: 'task', title: 'Item', ...over };
}

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

// ── createWorkItem — guards ──────────────────────────────────────────────

describe('createWorkItem — membership + reference guards', () => {
  it('rejects a project that does not exist with ProjectNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(createInput(fx, { projectId: MISSING_ID }), fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('rejects a reporter who is not a workspace member with ReporterNotInWorkspaceError', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await createTestUser();
    const outsiderCtx = { userId: outsider.id, workspaceId: fx.workspaceId };
    await expect(
      workItemsService.createWorkItem(createInput(fx), outsiderCtx),
    ).rejects.toBeInstanceOf(ReporterNotInWorkspaceError);
  });

  it('rejects an assignee who is not a workspace member with AssigneeNotInWorkspaceError', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await createTestUser();
    await expect(
      workItemsService.createWorkItem(createInput(fx, { assigneeId: outsider.id }), fx.ctx),
    ).rejects.toBeInstanceOf(AssigneeNotInWorkspaceError);
  });

  it('accepts an assignee + dueDate at create and round-trips them onto the DTO', async () => {
    const fx = await makeWorkItemFixture();
    const due = '2030-01-15T00:00:00.000Z';
    const created = await workItemsService.createWorkItem(
      createInput(fx, { assigneeId: fx.ownerId, dueDate: due }),
      fx.ctx,
    );
    expect(created.assigneeId).toBe(fx.ownerId);
    expect(created.dueDate).toBe(due);
  });

  it('rejects a parent that does not exist with WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(
        createInput(fx, { kind: 'task', parentId: MISSING_ID }),
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects a parent in another project with CrossProjectParentError', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PONE' });
    const p2 = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Project Two',
      identifier: 'PTWO',
    });
    const parentInP2 = await workItemsService.createWorkItem(
      { projectId: p2.id, kind: 'epic', title: 'Epic in P2' },
      fx.ctx,
    );
    await expect(
      workItemsService.createWorkItem(
        createInput(fx, { kind: 'story', parentId: parentInP2.id }),
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossProjectParentError);
  });
});

// ── updateWorkItem — not-found + per-field diff branches ─────────────────

describe('updateWorkItem — not-found', () => {
  it('empty patch on a missing id throws WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(workItemsService.updateWorkItem(MISSING_ID, {}, fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });

  it('a real patch on a missing id throws WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.updateWorkItem(MISSING_ID, { title: 'x' }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('updateWorkItem — per-field change branches', () => {
  // status is NOT an updateWorkItem field anymore (2.3.6/finding #46) — its diff
  // path lives in updateStatus (tests/workflows/transition-validation.test.ts).
  it('updates descriptionMd, priority, estimateMinutes and records each in the diff', async () => {
    const fx = await makeWorkItemFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'T', descriptionMd: 'old desc', priority: 'low' }),
      fx.ctx,
    );
    const updated = await workItemsService.updateWorkItem(
      created.id,
      {
        descriptionMd: 'new desc',
        priority: 'high',
        estimateMinutes: 120,
      },
      fx.ctx,
    );
    expect(updated.descriptionMd).toBe('new desc');
    expect(updated.priority).toBe('high');
    expect(updated.estimateMinutes).toBe(120);
  });

  it('sets then clears a dueDate (instant comparison both ways)', async () => {
    const fx = await makeWorkItemFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);

    const withDue = await workItemsService.updateWorkItem(
      created.id,
      { dueDate: '2031-06-01T00:00:00.000Z' },
      fx.ctx,
    );
    expect(withDue.dueDate).toBe('2031-06-01T00:00:00.000Z');

    const cleared = await workItemsService.updateWorkItem(created.id, { dueDate: null }, fx.ctx);
    expect(cleared.dueDate).toBeNull();
  });

  it('re-parents to a different parent and back to top-level', async () => {
    const fx = await makeWorkItemFixture();
    const epicA = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'EA' }),
      fx.ctx,
    );
    const epicB = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'EB' }),
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S', parentId: epicA.id }),
      fx.ctx,
    );

    const moved = await workItemsService.updateWorkItem(story.id, { parentId: epicB.id }, fx.ctx);
    expect(moved.parentId).toBe(epicB.id);

    // A story can legally be top-level (only a subtask requires a parent).
    const toRoot = await workItemsService.updateWorkItem(story.id, { parentId: null }, fx.ctx);
    expect(toRoot.parentId).toBeNull();
  });

  it('rejects re-parenting to a missing parent (WorkItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S' }),
      fx.ctx,
    );
    await expect(
      workItemsService.updateWorkItem(story.id, { parentId: MISSING_ID }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects re-parenting under a cross-project parent (CrossProjectParentError)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PONE' });
    const p2 = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Project Two',
      identifier: 'PTWO',
    });
    const epicP2 = await workItemsService.createWorkItem(
      { projectId: p2.id, kind: 'epic', title: 'Epic P2' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S' }),
      fx.ctx,
    );
    await expect(
      workItemsService.updateWorkItem(story.id, { parentId: epicP2.id }, fx.ctx),
    ).rejects.toBeInstanceOf(CrossProjectParentError);
  });

  it('rejects assigning a non-member on update (AssigneeNotInWorkspaceError)', async () => {
    const fx = await makeWorkItemFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    const outsider = await createTestUser();
    await expect(
      workItemsService.updateWorkItem(created.id, { assigneeId: outsider.id }, fx.ctx),
    ).rejects.toBeInstanceOf(AssigneeNotInWorkspaceError);
  });
});

// ── moveWorkItem — no-op + not-found + guard branches ────────────────────

describe('moveWorkItem — no-op + guards', () => {
  it('a move with no parent change and no neighbors is a no-op (position unchanged)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(createInput(fx, { title: 'Solo' }), fx.ctx);
    const moved = await workItemsService.moveWorkItem(item.id, {}, fx.ctx);
    expect(moved.position).toBe(item.position);
    expect(moved.parentId).toBe(item.parentId);
  });

  it('throws WorkItemNotFoundError when the moved item is missing', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.moveWorkItem(MISSING_ID, { beforeId: null, afterId: null }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('throws WorkItemNotFoundError when the new parent is missing', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S' }),
      fx.ctx,
    );
    await expect(
      workItemsService.moveWorkItem(story.id, { newParentId: MISSING_ID }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects an illegal re-parent kind during move (IllegalParentTypeError)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'E' }),
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S', parentId: epic.id }),
      fx.ctx,
    );
    // Move the epic under the story → epic may not have a parent.
    await expect(
      workItemsService.moveWorkItem(epic.id, { newParentId: story.id }, fx.ctx),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
  });
});

// ── listWorkItems — filter branches ──────────────────────────────────────

describe('listWorkItems — filters', () => {
  it('filters by status and by assignee', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    // 2.3.6/finding #46: status isn't an updateWorkItem patch field anymore —
    // set both via a direct write for this list-filter setup.
    await db.workItem.update({
      where: { id: a.id },
      data: { status: 'done', assigneeId: fx.ownerId },
    });

    const done = await workItemsService.listWorkItems(fx.projectId, { status: 'done' }, fx.ctx);
    expect(done.map((w) => w.id)).toEqual([a.id]);

    const mine = await workItemsService.listWorkItems(
      fx.projectId,
      { assigneeId: fx.ownerId },
      fx.ctx,
    );
    expect(mine.map((w) => w.id)).toEqual([a.id]);
  });
});

// ── linkWorkItems / unlinkWorkItems — not-found + cross-workspace ─────────

describe('linkWorkItems / unlinkWorkItems — guards', () => {
  it('rejects a link whose from item is missing (WorkItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    await expect(
      workItemsService.linkWorkItems(
        { fromId: MISSING_ID, toId: b.id, kind: 'relates_to' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects a link whose to item is missing (WorkItemNotFoundError)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    await expect(
      workItemsService.linkWorkItems(
        { fromId: a.id, toId: MISSING_ID, kind: 'relates_to' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects a cross-workspace link at the service guard (CrossWorkspaceLinkError)', async () => {
    const fx1 = await makeWorkItemFixture({ name: 'WS One', identifier: 'WONE' });
    const fx2 = await makeWorkItemFixture({ name: 'WS Two', identifier: 'WTWO' });
    const a = await workItemsService.createWorkItem(createInput(fx1, { title: 'A' }), fx1.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx2, { title: 'B' }), fx2.ctx);
    await expect(
      workItemsService.linkWorkItems({ fromId: a.id, toId: b.id, kind: 'relates_to' }, fx1.ctx),
    ).rejects.toBeInstanceOf(CrossWorkspaceLinkError);
  });

  it('unlink of a missing link throws WorkItemLinkNotFoundError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(workItemsService.unlinkWorkItems(MISSING_ID, fx.ctx)).rejects.toBeInstanceOf(
      WorkItemLinkNotFoundError,
    );
  });

  it('unlink of an is_blocked_by link removes exactly that row (no reciprocal path)', async () => {
    const fx = await makeWorkItemFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.unlinkWorkItems(link.id, fx.ctx);
    expect(await workItemsService.getBlockers(a.id, fx.ctx)).toEqual([]);
  });
});
