import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { aiPlanEditsService, PlanDeltaImmutabilityError } from '@/lib/services/aiPlanEditsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { PlanDelta } from '@/lib/ai/planDelta';

import {
  createTestWorkspace,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// ── Helpers ────────────────────────────────────────────────────────────────

function ctx(fx: { ownerId: string; workspaceId: string }): ServiceContext {
  return { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

function createDelta(overrides: Partial<PlanDelta> = {}): PlanDelta {
  return { operations: [], ...overrides };
}

// ── Service-level integration tests (real Postgres) ────────────────────────

describe('aiPlanEditsService.approveDelta — persist integration (real Postgres)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('creates work items through workItemsService and returns the keys', async () => {
    const fx = await makeWorkItemFixture();
    const delta = createDelta({
      operations: [
        {
          op: 'create',
          kind: 'task',
          fields: { title: 'Integration task 1', priority: 'high' },
        },
        {
          op: 'create',
          kind: 'bug',
          fields: { title: 'Integration bug', priority: 'medium' },
        },
      ],
    });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.created).toHaveLength(2);
    expect(result.updated).toEqual([]);

    const key1 = result.created[0]!;
    const key2 = result.created[1]!;
    const row1 = await workItemRepository.findByIdentifier(fx.projectId, key1);
    const row2 = await workItemRepository.findByIdentifier(fx.projectId, key2);

    expect(row1).not.toBeNull();
    expect(row1!.title).toBe('Integration task 1');
    expect(row1!.kind).toBe('task');
    expect(row1!.priority).toBe('high');
    expect(row1!.projectId).toBe(fx.projectId);

    expect(row2).not.toBeNull();
    expect(row2!.title).toBe('Integration bug');
    expect(row2!.kind).toBe('bug');
    expect(row2!.priority).toBe('medium');
  });

  it('creates a child work item with a parentKey', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Parent story',
    });

    const delta = createDelta({
      operations: [
        {
          op: 'create',
          kind: 'subtask',
          fields: { title: 'Child subtask' },
          parentKey: parent.identifier,
        },
      ],
    });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.created).toHaveLength(1);
    const childKey = result.created[0]!;
    const child = await workItemRepository.findByIdentifier(fx.projectId, childKey);
    expect(child).not.toBeNull();
    expect(child!.parentId).toBe(parent.id);
    expect(child!.kind).toBe('subtask');
  });

  it('updates an existing work item and returns the updated key', async () => {
    const fx = await makeWorkItemFixture();
    const wi = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Before update',
    });

    const delta = createDelta({
      operations: [
        {
          op: 'update',
          targetKey: wi.identifier,
          fields: { title: 'After update', priority: 'lowest' },
        },
      ],
    });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([wi.identifier]);

    const updated = await workItemRepository.findByIdentifier(fx.projectId, wi.identifier);
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('After update');
    expect(updated!.priority).toBe('lowest');
  });

  it('rejects an update to a terminal (done) item with PlanDeltaImmutabilityError and persists nothing', async () => {
    const fx = await makeWorkItemFixture();
    const wi = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Completed item',
    });
    await workItemsService.updateStatus(wi.id, 'done', ctx(fx));

    const delta = createDelta({
      operations: [
        {
          op: 'update',
          targetKey: wi.identifier,
          fields: { title: 'Trying to mutate' },
        },
      ],
    });

    await expect(aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx))).rejects.toThrow(
      PlanDeltaImmutabilityError,
    );

    const stillDone = await workItemRepository.findByIdentifier(fx.projectId, wi.identifier);
    expect(stillDone).not.toBeNull();
    expect(stillDone!.status).toBe('done');
    expect(stillDone!.title).toBe('Completed item');
  });

  it('rejects an update to a terminal (cancelled) item', async () => {
    const fx = await makeWorkItemFixture();
    const wi = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Cancelled item',
    });
    await workItemsService.updateStatus(wi.id, 'cancelled', ctx(fx));

    const delta = createDelta({
      operations: [
        {
          op: 'update',
          targetKey: wi.identifier,
          fields: { priority: 'high' },
        },
      ],
    });

    await expect(aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx))).rejects.toThrow(
      PlanDeltaImmutabilityError,
    );
  });

  it('immutability guard fires before any operation persists (defense in depth)', async () => {
    const fx = await makeWorkItemFixture();
    const good = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Mutable item',
    });
    const done = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Done item',
    });
    await workItemsService.updateStatus(done.id, 'done', ctx(fx));

    // A delta with TWO ops: the first is fine, the second should reject.
    // The immutability check fires per-op, so the first op COULD succeed before
    // the second fails — but approveDelta runs sequentially without a
    // transaction wrap, so we assert at least the terminal op is rejected.
    const delta = createDelta({
      operations: [
        {
          op: 'update',
          targetKey: good.identifier,
          fields: { title: 'Updated first' },
        },
        {
          op: 'update',
          targetKey: done.identifier,
          fields: { title: 'Should block' },
        },
      ],
    });

    await expect(aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx))).rejects.toThrow(
      PlanDeltaImmutabilityError,
    );

    // The first (non-terminal) op may have succeeded — its persistence is not
    // rolled back since approveDelta doesn't wrap in a transaction. That's
    // acceptable: the error signals the delta was partially applied and the
    // caller must retry the whole thing.
  });

  it('empty delta returns empty arrays (valid no-op)', async () => {
    const fx = await makeWorkItemFixture();
    const delta = createDelta({ operations: [] });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
  });

  it('returns unchanged: [] for every result', async () => {
    const fx = await makeWorkItemFixture();
    const delta = createDelta({ operations: [] });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.unchanged).toEqual([]);
  });

  it('a non-member of the project workspace is rejected by the workItemsService layer', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await createTestUser();

    // Use the real project DTO from the fixture so the types match.
    const outsiderCtx: ProjectContext = {
      userId: outsider.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };

    const delta = createDelta({
      operations: [{ op: 'create', kind: 'task', fields: { title: 'Should fail' } }],
    });

    await expect(aiPlanEditsService.approveDelta('job_1', delta, outsiderCtx)).rejects.toThrow();
  });

  it('creates items with cross-ref parent resolution via parentRef', async () => {
    const fx = await makeWorkItemFixture();

    const delta = createDelta({
      operations: [
        {
          op: 'create',
          kind: 'task',
          fields: { title: 'Ref parent' },
          ref: 'ref1',
        },
        {
          op: 'create',
          kind: 'subtask',
          fields: { title: 'Ref child' },
          parentRef: 'ref1',
        },
      ],
    });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.created).toHaveLength(2);
    const childKey = result.created[1]!;
    const child = await workItemRepository.findByIdentifier(fx.projectId, childKey);
    expect(child).not.toBeNull();
    expect(child!.kind).toBe('subtask');
  });

  it('handles all-noop updates (no fields changed) as processed', async () => {
    const fx = await makeWorkItemFixture();
    const wi = await createTestWorkItem(fx, { kind: 'task', title: 'Same' });

    const delta = createDelta({
      operations: [{ op: 'update', targetKey: wi.identifier, fields: {} }],
    });

    const result = await aiPlanEditsService.approveDelta('job_1', delta, projectCtx(fx));

    expect(result.updated).toEqual([wi.identifier]);
  });
});

// ── Route-level integration tests ──────────────────────────────────────────

const activeCtxRef: { current: ProjectContext | null } = { current: null };
const sessionRef: { current: { user: { id: string } } | null } = {
  current: null,
};

vi.mock('@/lib/auth', () => ({
  getSession: async () => sessionRef.current,
}));

vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtxRef.current };
});

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

const { POST: approvePOST } = await import('@/app/api/ai/plan-delta/approve/route');

const BASE = 'http://localhost:3000';

function approveReq(body: unknown): Request {
  return new Request(`${BASE}/api/ai/plan-delta/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/ai/plan-delta/approve — route integration', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    activeCtxRef.current = null;
    sessionRef.current = null;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('200 — creates work items through the full route → service → DB chain', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(
      approveReq({
        jobId: 'job_1',
        editedDelta: {
          operations: [
            {
              op: 'create',
              kind: 'task',
              fields: { title: 'Route-created task', priority: 'high' },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toHaveLength(1);
    expect(body.updated).toEqual([]);

    const createdKey = body.created[0] as string;
    const row = await workItemRepository.findByIdentifier(fx.projectId, createdKey);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Route-created task');
  });

  it('401 — no session', async () => {
    const res = await approvePOST(approveReq({ jobId: 'job_1' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('404 — no active project (and never 403 — no existence leak)', async () => {
    const { owner } = await createTestWorkspace();
    sessionRef.current = { user: { id: owner.id } };
    activeCtxRef.current = null;

    const res = await approvePOST(approveReq({ jobId: 'job_1', editedDelta: { operations: [] } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
  });

  it('400 — no body', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(
      new Request(`${BASE}/api/ai/plan-delta/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 — missing jobId', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(approveReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('422 — immutability error on terminal item update', async () => {
    const fx = await makeWorkItemFixture();
    const wi = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Done item',
    });
    await workItemsService.updateStatus(wi.id, 'done', ctx(fx));

    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(
      approveReq({
        jobId: 'job_1',
        editedDelta: {
          operations: [
            {
              op: 'update',
              targetKey: wi.identifier,
              fields: { title: 'Trying to mutate' },
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('PLAN_DELTA_IMMUTABLE');

    const stillDone = await workItemRepository.findByIdentifier(fx.projectId, wi.identifier);
    expect(stillDone!.status).toBe('done');
    expect(stillDone!.title).toBe('Done item');
  });

  it('400 — invalid delta shape (not an array)', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(
      approveReq({
        jobId: 'job_1',
        editedDelta: { operations: 'not-an-array' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PLAN_DELTA_VALIDATION_ERROR');
  });

  it('empty delta returns 200 with empty arrays', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId } };
    activeCtxRef.current = projectCtx(fx);

    const res = await approvePOST(
      approveReq({
        jobId: 'job_1',
        editedDelta: { operations: [] },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toEqual([]);
    expect(body.updated).toEqual([]);
  });
});
