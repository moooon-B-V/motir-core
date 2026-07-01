import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OUTWARD bug-telemetry DISPATCH side (Story 7.6 · MOTIR-1481). Real
// Postgres for the work-item tree the service reads; the ONE boundary seam
// stubbed is the motir-ai client (`submitJob`) + the org/meta resolver
// (`resolveTenantOrg`, covered by tenantOrg.test.ts) — so no network, and the
// assertion surface is "what did we dispatch (or not)". Covers: kind-filter,
// the meta-project skip, the ai-not-configured short-circuit, the assembled
// analysis context (bugKey / text / plan-tree neighborhood roles), and that a
// dispatch failure propagates (for the trigger's retry) without touching the
// already-committed bug.

vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { db } from '@/lib/db';
import { aiBugTelemetryService } from '@/lib/services/aiBugTelemetryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { BugAnalysisContext } from '@/lib/ai/types';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: false });
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('aiBugTelemetryService.dispatchOutwardAnalysis', () => {
  it('dispatches exactly one analyze_bug job for a kind:bug in a non-Motir project, with the assembled context', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Checkout' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Cart totals', parentId: epic.id },
      fx.ctx,
    );
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'Tax double-counted',
        descriptionMd: 'Totals add tax twice at checkout.',
        parentId: story.id,
      },
      fx.ctx,
    );

    const out = await aiBugTelemetryService.dispatchOutwardAnalysis({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: bug.id,
      actorId: fx.ownerId,
    });

    expect(out).toEqual({ dispatched: true, jobId: 'job_1' });
    expect(submitJob).toHaveBeenCalledTimes(1);

    const [kind, tenant, context, actor] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('analyze_bug');
    expect(tenant).toEqual({
      organizationId: 'org_1',
      isMeta: false,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: 'ACME',
    });
    expect(actor).toEqual({ userId: fx.ownerId });

    const bugAnalysis = (context as { bugAnalysis: BugAnalysisContext }).bugAnalysis;
    expect(bugAnalysis.bugKey).toBe(bug.identifier);
    expect(bugAnalysis.bug).toEqual({
      title: 'Tax double-counted',
      descriptionMd: 'Totals add tax twice at checkout.',
      comments: [],
    });
    // The parent chain rides as the owning story + owning epic.
    expect(bugAnalysis.planNeighborhood).toEqual([
      expect.objectContaining({ key: story.identifier, kind: 'story', role: 'owning_story' }),
      expect.objectContaining({ key: epic.identifier, kind: 'epic', role: 'owning_epic' }),
    ]);
    expect(resolveTenantOrg).toHaveBeenCalledWith({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
  });

  it('dispatches nothing for a non-bug create', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Add a coupon field' },
      fx.ctx,
    );

    const out = await aiBugTelemetryService.dispatchOutwardAnalysis({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: task.id,
      actorId: fx.ownerId,
    });

    expect(out).toEqual({ dispatched: false, reason: 'not-a-bug' });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('skips a bug in the Motir meta project — the inward loop owns it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const bug = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'Planner mis-scoped a card',
        descriptionMd: 'x',
      },
      fx.ctx,
    );

    const out = await aiBugTelemetryService.dispatchOutwardAnalysis({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: bug.id,
      actorId: fx.ownerId,
    });

    expect(out).toEqual({ dispatched: false, reason: 'meta-project' });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('short-circuits when motir-ai is not configured (self-hosted open-core, no AI backend)', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('MOTIR_AI_URL', '');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const bug = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'A bug', descriptionMd: 'x' },
      fx.ctx,
    );

    const out = await aiBugTelemetryService.dispatchOutwardAnalysis({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: bug.id,
      actorId: fx.ownerId,
    });

    expect(out).toEqual({ dispatched: false, reason: 'ai-not-configured' });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('propagates a dispatch failure (for the idempotent retry) without touching the committed bug', async () => {
    vi.mocked(submitJob).mockRejectedValueOnce(new Error('motir-ai unavailable'));
    const fx = await makeWorkItemFixture({ identifier: 'ACME' });
    const bug = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'A bug', descriptionMd: 'x' },
      fx.ctx,
    );

    await expect(
      aiBugTelemetryService.dispatchOutwardAnalysis({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: bug.id,
        actorId: fx.ownerId,
      }),
    ).rejects.toThrow('motir-ai unavailable');

    // The originating create is untouched — the dispatch is a decoupled
    // post-commit side effect, so its failure never rolls the bug back.
    const stillThere = await workItemsService.getWorkItem(bug.id, fx.ctx);
    expect(stillThere.id).toBe(bug.id);
  });
});
