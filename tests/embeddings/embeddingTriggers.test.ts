import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { backlogService } from '@/lib/services/backlogService';
import type { WorkItemEmbeddingRequestedData } from '@/lib/jobs/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// WHEN the embedding job is enqueued (Story MOTIR-2694 · Subtask MOTIR-2696, ADR
// §3 + §6.3.1) — the EMIT GATE, asserted from the write path rather than from the
// job.
//
// This is where the ADR's central cost claim is either true or false. "The
// re-embed trigger is the CONTENT hash, not the row" is what makes the feature
// affordable: a status flip, a re-parent, a sprint move, an assignee change, a
// priority bump and a reorder are the overwhelming majority of work-item writes,
// and every one of them must cost NOTHING. A gate that merely fires "on update"
// would be indistinguishable in a green suite and would multiply the bill by an
// order of magnitude, so each of those writes is asserted individually rather
// than as a representative sample.
//
// The one external seam stubbed is the Inngest client's `send()` — the
// tests/helpers/jobs.ts convention: there is no dev server in tests, and it
// doubles as the assertion surface for the post-commit events.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Capture every `work-item/embedding.requested` publish (and block the network). */
function captureEmbeddingEvents(): WorkItemEmbeddingRequestedData[] {
  const events: WorkItemEmbeddingRequestedData[] = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    for (const entry of Array.isArray(payload) ? payload : [payload]) {
      const evt = entry as { name?: string; data?: WorkItemEmbeddingRequestedData };
      if (evt?.name === 'work-item/embedding.requested' && evt.data) events.push(evt.data);
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return events;
}

async function scenario(): Promise<{ fx: WorkItemFixture; ctx: ServiceContext }> {
  const fx = await makeWorkItemFixture({ identifier: 'TRG' });
  return { fx, ctx: fx.ctx };
}

describe('create', () => {
  it('enqueues exactly one embedding request, carrying only the ids', async () => {
    const { fx, ctx } = await scenario();
    const events = captureEmbeddingEvents();

    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Board columns' },
      ctx,
    );

    // The payload is an ID, never the text (§6.3.3) — the job re-reads, and that
    // is what makes two rapid edits converge with no ordering guard.
    expect(events).toEqual([{ workspaceId: fx.workspaceId, workItemId: created.id }]);
  });
});

describe('update — the CONTENT gate (ADR §3)', () => {
  it('enqueues when the TITLE changes', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Before' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { title: 'After' }, ctx);

    expect(events).toEqual([{ workspaceId: fx.workspaceId, workItemId: item.id }]);
  });

  it('enqueues when the DESCRIPTION changes', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { descriptionMd: 'a body' }, ctx);

    expect(events).toHaveLength(1);
  });

  it('does NOT enqueue for an EXPLANATION-only edit — it is not in the document', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { explanationMd: 'why it matters' }, ctx);

    expect(events).toEqual([]);
  });

  it('does NOT enqueue for a STATUS-only change', async () => {
    const { fx, ctx } = await scenario();
    // Through the real create, so the row carries the project workflow's INITIAL
    // status and the transition below is a legal one.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Same' },
      ctx,
    );
    const events = captureEmbeddingEvents();

    await workItemsService.updateStatus(item.id, 'in_progress', ctx);

    // Status is the single most common work-item write there is; if it cost an
    // embedding the ADR's whole cost argument would be wrong.
    expect(events).toEqual([]);
  });

  it('does NOT enqueue for a RE-PARENT', async () => {
    const { fx, ctx } = await scenario();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Child' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { parentId: story.id }, ctx);

    expect(events).toEqual([]);
  });

  it('does NOT enqueue for a SPRINT move', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });
    const sprint = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Sprint 1',
        sequence: 1,
      },
    });
    const events = captureEmbeddingEvents();

    // Through the real sprint-assignment path — `sprintId` is not even a field
    // on the free-form patch, so a fake one here would prove nothing.
    await backlogService.assignToSprint(item.id, sprint.id, undefined, ctx);

    expect(events).toEqual([]);
  });

  it('does NOT enqueue for an ASSIGNEE change', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { assigneeId: fx.ownerId }, ctx);

    expect(events).toEqual([]);
  });

  it('does NOT enqueue for a PRIORITY bump or an ESTIMATE edit', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { priority: 'high' }, ctx);
    await workItemsService.updateWorkItem(item.id, { estimateMinutes: 45 }, ctx);
    await workItemsService.updateWorkItem(item.id, { storyPoints: 3 }, ctx);

    expect(events).toEqual([]);
  });

  it('does NOT enqueue for a NO-OP patch that sets the title to what it already is', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Unchanged' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(item.id, { title: 'Unchanged' }, ctx);

    expect(events).toEqual([]);
  });

  it('enqueues ONCE for a mixed patch that moves the title AND the assignee', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Before' });
    const events = captureEmbeddingEvents();

    await workItemsService.updateWorkItem(
      item.id,
      { title: 'After', assigneeId: fx.ownerId, priority: 'high' },
      ctx,
    );

    expect(events).toHaveLength(1);
  });
});

describe('archive / delete', () => {
  it('does NOT enqueue on archive — the embedding is KEPT (ADR §5)', async () => {
    const { fx, ctx } = await scenario();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Retire me' });
    const events = captureEmbeddingEvents();

    await workItemsService.archiveWorkItem(item.id, ctx);
    await workItemsService.unarchiveWorkItem(item.id, ctx);

    // Un-archiving restores candidacy with no re-embed — the row never left.
    expect(events).toEqual([]);
  });
});
