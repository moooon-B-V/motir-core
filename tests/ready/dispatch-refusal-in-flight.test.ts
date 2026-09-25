import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { ArchivedTargetRepoError } from '@/lib/workItems/errors';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';
import { describeInFlight, inFlightBackends } from '../helpers/inFlightWork';

// MOTIR-6235 — MOTIR-3066's deadlock, again, through the DISPATCH fan-outs.
//
// CI's `Vitest (8/12)` killed `projectScopedDispatchRepo.test.ts`'s
// `beforeEach` reset with `40P01`. Reproduced locally by refusing a dispatch
// against an ARCHIVED repository and running the reset straight after: 14 of 40
// resets died, and Postgres named the same pair MOTIR-3066 recorded —
//
//   reset TRUNCATE   waits AccessExclusiveLock on "project",              blocked by
//   abandoned read   waits AccessShareLock     on "workspace_membership", blocked by the reset
//
// The dispatch payload (`buildReadyDispatchDto`, behind `next_ready`,
// `claim_next_ready` and `POST /api/ready/next`) and the dispatch prompt
// (`dispatchPromptService.getDispatchPrompt`) each fan their reads out with
// `Promise.all`, and one arm is `resolveDispatchRepoForItem`. MOTIR-3077 left
// both on `Promise.all` because "that arm returns `null` rather than
// throwing" — but since MOTIR-1959 it THROWS `ArchivedTargetRepoError` for an
// archived repository. `Promise.all` rejects on that throw and returns while the
// sibling arms' `withWorkspaceServiceContext` transactions are still open.
//
// So this file asserts the invariant the reset depends on: a REFUSED dispatch
// leaves nothing running. Unaided the leak is a race (5 of 12 refused prompts
// left work behind locally, the four-arm payload 0 of 12 on a quiet box — CI
// load is what widens it), so each refusal test holds ONE sibling arm's real
// transaction open for a moment. That is a real transaction on the real
// database, not a mock: it pins the window the loaded runner opened by chance.
// Before the fix every refusal below leaves that transaction `idle in
// transaction`; after it, the refusal waits for every arm.

const HOLD_MS = 300;

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

/** A project whose only established repository is ARCHIVED on the host, and one
 *  ready, unpinned item — so every dispatch surface resolves it and refuses. */
async function archivedScenario(): Promise<{ fx: WorkItemFixture; identifier: string }> {
  const fx = await makeWorkItemFixture();
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'acme-web' },
    fx.ctx,
  );
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `acme-web-${randomToken(8)}`,
      owner: 'moooon',
      name: 'acme-web',
      defaultBranch: 'main',
      archived: true,
      provider: 'github',
    },
  });
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'dispatch me', assigneeId: null },
    fx.ctx,
  );
  return { fx, identifier: item.identifier };
}

/** Make the READINESS arm — a sibling of the repo arm in BOTH fan-outs — finish
 *  inside a transaction that stays open for `HOLD_MS` after its answer. */
function holdReadinessArmOpen(): void {
  const readiness = workItemsService.getReadiness.bind(workItemsService);
  vi.spyOn(workItemsService, 'getReadiness').mockImplementation(async (id, ctx) => {
    const answer = await readiness(id, ctx);
    await withWorkspaceServiceContext(ctx.workspaceId, async () => {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    });
    return answer;
  });
}

async function expectNothingInFlight(what: string): Promise<void> {
  const leftover = await inFlightBackends();
  expect(
    leftover,
    `${what} left ${leftover.length} backend(s) in flight:\n${describeInFlight(leftover)}`,
  ).toEqual([]);
}

describe('a REFUSED dispatch leaves no work in flight (MOTIR-6235)', () => {
  it('the ready dispatch payload (`next_ready` / `POST /api/ready/next`)', async () => {
    const { fx } = await archivedScenario();
    holdReadinessArmOpen();

    await expect(workItemsService.getNextReady(fx.projectId, {}, fx.ctx)).rejects.toBeInstanceOf(
      ArchivedTargetRepoError,
    );
    await expectNothingInFlight('a refused next_ready');
  });

  it('the claimed dispatch payload (`claim_next_ready`)', async () => {
    const { fx } = await archivedScenario();
    holdReadinessArmOpen();

    await expect(
      workItemsService.claimNextReady(fx.projectId, null, fx.ctx),
    ).rejects.toBeInstanceOf(ArchivedTargetRepoError);
    await expectNothingInFlight('a refused claim_next_ready');
  });

  it('the dispatch prompt (`dispatch_prompt`)', async () => {
    const { fx, identifier } = await archivedScenario();
    holdReadinessArmOpen();

    await expect(
      dispatchPromptService.getDispatchPrompt(fx.projectId, identifier, fx.ctx),
    ).rejects.toBeInstanceOf(ArchivedTargetRepoError);
    await expectNothingInFlight('a refused dispatch_prompt');
  });

  it('an ACCEPTED dispatch still returns its payload and leaves nothing running', async () => {
    const { fx, identifier } = await archivedScenario();
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { archived: false },
    });

    const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dispatch).toMatchObject({ targetRepo: 'acme-web', targetRepoDefaultBranch: 'main' });
    const prompt = await dispatchPromptService.getDispatchPrompt(fx.projectId, identifier, fx.ctx);
    expect(prompt.targetRepo).toBe('acme-web');
    await expectNothingInFlight('an accepted dispatch');
  });
});
