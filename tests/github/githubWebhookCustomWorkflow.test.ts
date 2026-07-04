import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusCategory } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-896 — the CUSTOM-WORKFLOW no-match branch of the PR →
// status sync (the one enumerated 7.7.4 case no per-subtask test covers): a
// project whose workflow has NO status in the lifecycle's target CATEGORY must
// resolve to a logged `no_matching_status` no-op — never a crash, never a raw
// status write (githubWebhookService.resolveTargetStatusKey → null).
//
// The admin surface can't produce this workflow: DEFAULT_STATUS_KEYS are
// protected (2.2.10 — deleteStatus throws DefaultStatusProtectedError), so a
// project missing a whole category is unreachable through workflowsService.
// The state machine still defends against it (a future workflow-template /
// import path, or hand-edited data), so the test seeds the degenerate workflow
// at the DB layer — setup only; the path under test runs the real service.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-custom-wf';
const REPO_PROVIDER_ID = '777';

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
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      { providerRepoId: REPO_PROVIDER_ID, owner: 'moooon', name: 'acme', defaultBranch: 'main' },
    ],
  });
  return { user, workspace, project, item, ctx };
}

/** Remove EVERY status of `category` from the project's workflow (plus the
 *  transitions touching them, FK-first) — the degenerate custom workflow the
 *  admin surface forbids but the webhook must survive. */
async function dropStatusCategory(projectId: string, category: StatusCategory): Promise<void> {
  await withSystemContext(async (tx) => {
    const doomed = await tx.workflowStatus.findMany({ where: { projectId, category } });
    const ids = doomed.map((s) => s.id);
    await tx.workflowTransition.deleteMany({
      where: { OR: [{ fromStatusId: { in: ids } }, { toStatusId: { in: ids } }] },
    });
    await tx.workflowStatus.deleteMany({ where: { id: { in: ids } } });
  });
}

function prPayload(opts: {
  action: string;
  identifier: string;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: {
      id: INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `feat/${opts.identifier}-a-change` },
      user: { id: 4242 },
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
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
});

describe('githubWebhookService — custom workflow with NO matching status (MOTIR-896)', () => {
  it('PR opened with no in_progress-category status → no_matching_status no-op, item untouched', async () => {
    const { project, item } = await makeScenario('wf-a@example.com');
    const identifier = `ACME-1`;
    // The default flow carries `in_progress` + `in_review` (both category
    // in_progress); dropping the category leaves NOTHING for the `in_review`
    // lifecycle to resolve to — byKey misses, byCategory misses → null.
    await dropStatusCategory(project.id, 'in_progress');
    // createWorkItem writes its own `created` revision; the no-op must add none.
    const revisionsBefore = await db.workItemRevision.count({ where: { workItemId: item.id } });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier }),
    );

    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'no_matching_status',
      workItemId: item.id,
    });
    // No status write, no new revision — the item is exactly where it started.
    expect(await statusOf(item.id)).toBe('todo');
    const revisionsAfter = await db.workItemRevision.count({ where: { workItemId: item.id } });
    expect(revisionsAfter).toBe(revisionsBefore);
  });

  it('the PR row is still upserted on a no-match delivery (the link survives; only the transition no-ops)', async () => {
    const { project, item } = await makeScenario('wf-b@example.com');
    await dropStatusCategory(project.id, 'in_progress');

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: 'ACME-1' }),
    );

    const pr = await withSystemContext((tx) =>
      tx.githubPullRequest.findFirst({ where: { number: 7 } }),
    );
    expect(pr).not.toBeNull();
    expect(pr!.workItemId).toBe(item.id);
  });

  it('PR merged with no done-category status → no_matching_status no-op (the done lifecycle)', async () => {
    const { project, item, ctx } = await makeScenario('wf-c@example.com');
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    // Drop BOTH terminals (`done` + `cancelled`) — the `done` lifecycle's key
    // AND category both miss.
    await dropStatusCategory(project.id, 'done');

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: 'ACME-1', state: 'closed', merged: true }),
    );

    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'no_matching_status',
      workItemId: item.id,
    });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});
