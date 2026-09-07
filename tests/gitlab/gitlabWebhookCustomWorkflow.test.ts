import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusCategory } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deliveredItemIds, linkPrByIdentifier } from '../helpers/prLink';

// Story 7.23 · MOTIR-1479 — the CUSTOM-WORKFLOW no-match branch of the MR →
// status sync (mirroring `tests/github/githubWebhookCustomWorkflow.test.ts` /
// MOTIR-896): a project whose workflow has NO status in the lifecycle's target
// CATEGORY must resolve to `no_matching_status` — never a crash, never a raw
// status write. The GitLab webhook drives the SAME shared `syncChangeRequestStatus`
// state machine GitHub uses, so the `no_matching_status` arm is tested once here
// to prove the GitLab call site feeds into it correctly.
//
// The admin surface can't produce this workflow (DEFAULT_STATUS_KEYS are
// protected), so the test seeds the degenerate workflow at the DB layer — setup
// only; the path under test runs the real service.

const PASSWORD = 'hunter2hunter2';
const PROJECT_ID = '42';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );

  await withSystemContext(async (tx) => {
    const connection = await githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
      tx,
    );
    await githubRepoRepository.upsert(
      {
        installationId: connection.id,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        repoId: PROJECT_ID,
        owner: 'octocat',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
      tx,
    );
  });

  // MOTIR-3674 — the merge request every test here delivers is iid 7, and the
  // link is now the only thing that associates it with `item`.
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'octocat',
    name: 'acme',
    number: 7,
    headRef: `subtask/${item.identifier}-a-change`,
    title: `Some change (${item.identifier})`,
  });
  return { user, workspace, project, item, ctx };
}

/** Remove EVERY status of `category` from the project's workflow — the degenerate
 *  custom workflow the admin surface forbids but the webhook must survive. */
async function dropStatusCategory(projectId: string, category: StatusCategory): Promise<void> {
  // ⚠️ THE OWNER, not a system context (MOTIR-2887) — the twin of the helper in
  // `githubWebhookCustomWorkflow.test.ts`. `workflow_status` has no `system_admin`
  // read arm, so under `motir_app` this fixture deleted nothing, silently, and the
  // test measured the DEFAULT workflow while claiming to measure a custom one.
  const doomed = await adminDb.workflowStatus.findMany({ where: { projectId, category } });
  const ids = doomed.map((s) => s.id);
  await adminDb.workflowTransition.deleteMany({
    where: { OR: [{ fromStatusId: { in: ids } }, { toStatusId: { in: ids } }] },
  });
  await adminDb.workflowStatus.deleteMany({ where: { id: { in: ids } } });
}

function mrPayload(opts: {
  action: string;
  identifier: string;
  state?: 'opened' | 'closed' | 'merged';
}) {
  return {
    object_kind: 'merge_request',
    project: { id: Number(PROJECT_ID) },
    object_attributes: {
      iid: 7,
      action: opts.action,
      state: opts.state ?? 'opened',
      title: `Some change (${opts.identifier})`,
      source_branch: `subtask/${opts.identifier}-a-change`,
      target_branch: 'main',
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('gitlabWebhookService — custom workflow with NO matching status (MOTIR-1479)', () => {
  it('MR opened with no in_progress-category status → no_matching_status no-op', async () => {
    const { project, item } = await makeScenario('wf-a@example.com');
    await dropStatusCategory(project.id, 'in_progress');
    const revisionsBefore = await adminDb.workItemRevision.count({
      where: { workItemId: item.id },
    });

    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ACME-1' }),
    );

    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'no_matching_status',
      workItemId: item.id,
    });
    // The item stays at todo (the MR-open → in_review lifecycle needs an
    // in_progress-category status — all gone, so no transition).
    expect(await statusOf(item.id)).toBe('todo');
    const revisionsAfter = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });
    expect(revisionsAfter).toBe(revisionsBefore);
  });

  it('the MR row is still upserted on a no-match (the link survives; only the transition no-ops)', async () => {
    const { project, item } = await makeScenario('wf-b@example.com');
    await dropStatusCategory(project.id, 'in_progress');

    await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ACME-1' }),
    );

    // A direct-DB ASSERTION runs as the OWNER (MOTIR-2887).
    const mr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(await deliveredItemIds(mr.id)).toEqual([item.id]);
  });

  it('MR merged with no done-category status → no_matching_status no-op', async () => {
    const { project, item, ctx } = await makeScenario('wf-c@example.com');
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    await dropStatusCategory(project.id, 'done');

    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'merge', identifier: 'ACME-1', state: 'merged' }),
    );

    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'no_matching_status',
      workItemId: item.id,
    });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});
