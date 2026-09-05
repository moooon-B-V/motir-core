import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeGraphStatus: vi.fn(async (q: { repoRefs?: string[] }) => ({
    repos: (q.repoRefs ?? []).map((repoRef) => ({
      repoRef,
      indexed: true,
      commitSha: 'a'.repeat(40),
      indexedAt: '2026-09-01T10:00:00.000Z',
      codegraphVersion: '1.0.0',
    })),
  })),
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-4603 — AUTO-PLAN PAUSES WHEN MOTIR CANNOT READ THE CODE.
//
// **Auto-plan is Motir deciding to plan; clicking "Plan with AI" is the user
// deciding.** When Motir cannot read the code it stops deciding — and leaves the
// user's decision entirely alone. A cadence that keeps producing plans from work
// items alone, unasked, spends credit on output nobody requested and fills the
// board with plans built on less than they should have been.
//
// The two assertions that carry the whole distinction are the LAST two: manual
// planning is unaffected, and the user's checkbox is never mutated by a pause.

async function truncateAll(): Promise<void> {
  await truncateAuthTables();
}

async function enableAutoPlan(projectId: string): Promise<void> {
  await adminDb.project.update({
    where: { id: projectId },
    data: { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 },
  });
}

async function connectRepo(workspaceId: string): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: {
      installationId: `inst-${workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: `repo-${workspaceId}`,
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
}

/** A drained, opted-in project with one expandable stub. */
async function drained(connected: boolean): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  await enableAutoPlan(fx.projectId);
  if (connected) await connectRepo(fx.workspaceId);
  await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Unexpanded epic' },
    fx.ctx,
  );
  return fx;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the cadence holds off when Motir cannot read the code', () => {
  it('a project with NO connected repository fires nothing', async () => {
    const fx = await drained(false);

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toEqual({
      projectId: fx.projectId,
      status: 'skipped',
      reason: 'code_blind',
    });
    expect(vi.mocked(submitJob)).not.toHaveBeenCalled();
  });

  it('a project with a CURRENT graph fires normally — the common path is untouched', async () => {
    await drained(true);

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.fired).toBe(1);
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
  });

  it('CONNECTING a repository is enough to resume — no manual intervention, no setting touched', async () => {
    const fx = await drained(false);
    expect((await autoPlanCadenceService.runCadenceSweep()).fired).toBe(0);

    // The condition clears by itself; nothing is re-enabled and nothing is reset.
    await connectRepo(fx.workspaceId);

    expect((await autoPlanCadenceService.runCadenceSweep()).fired).toBe(1);
  });

  it('⚠️ MANUAL planning is UNAFFECTED — the user’s decision survives every path here', async () => {
    // The whole distinction between consent and a block. Auto-plan is Motir
    // deciding; this is the user deciding, and it must still work on the very
    // project the cadence just declined to act on.
    const fx = await drained(false);
    const summary = await autoPlanCadenceService.runCadenceSweep();
    expect(summary.outcomes[0]).toMatchObject({ reason: 'code_blind' });

    const stub = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Manual target' },
      fx.ctx,
    );
    const ctx = {
      ...fx.ctx,
      projectId: fx.projectId,
      project: fx.project,
    };

    await expect(aiPlanEditsService.submitExpand(stub.identifier, ctx)).resolves.toBeTruthy();
    expect(vi.mocked(submitJob)).toHaveBeenCalledTimes(1);
  });

  it('⚠️ the user’s CHECKBOX is never mutated by a pause', async () => {
    // The box records what the user WANTS. Silently unchecking it to reflect a
    // system state would be Motir editing their intent, and they would later find
    // a setting they never changed. The settings row explains the condition
    // instead; nothing here writes.
    const fx = await drained(false);
    const before = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    await autoPlanCadenceService.runCadenceSweep();
    await autoPlanCadenceService.runCadenceSweep();

    const after = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(after.aiAutoPlanEnabled).toBe(true);
    expect(after.aiAutoPlanEnabled).toBe(before.aiAutoPlanEnabled);
    expect(after.aiAutoPlanThreshold).toBe(before.aiAutoPlanThreshold);
  });
});
