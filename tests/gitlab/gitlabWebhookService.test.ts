import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.23 · MOTIR-1475 — the GitLab inbound webhook MR → work-item status sync,
// against a real Postgres (the motir-core convention). Proves GitLab MR hooks drive
// the SAME shared status-sync state machine GitHub uses (`changeRequestStatusSync`):
// opened → In Review, merged → Done, closed-unmerged → In Progress, attributed to
// the workspace owner (GitLab has no bound-identity table); plus the no-op paths
// (unconnected project, no linked work item, ignored MR action, non-MR event) and
// idempotent redelivery. Only DB is touched — a webhook has no network I/O here.

const PASSWORD = 'hunter2hunter2';
// A GitLab connection id is minted per workspace (`gitlab-ws-<id>`); the project id
// is the host's numeric id, stored as the repo's `repoId`.
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
  // Move to in_progress so an MR-opened → in_review is a legal transition.
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);

  // Seed a GitLab connection (the shared GithubInstallation under provider='gitlab')
  // + a connected project row, directly (system context) — the connect/settings UI
  // that persists these is a sibling card (MOTIR-1478), not shipped yet.
  await withSystemContext(async (tx) => {
    const connection = await githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
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
        repoId: PROJECT_ID,
        owner: 'octocat',
        name: 'acme',
        defaultBranch: 'main',
      },
      tx,
    );
  });

  return { user, workspace, project, item, ctx };
}

/** A GitLab `merge_request` webhook body, referencing a work item by its source
 *  branch. `action` is the MR action (open / reopen / close / merge / update);
 *  `state` is the resulting MR state. */
function mrPayload(opts: {
  action: string;
  identifier: string;
  state?: 'opened' | 'closed' | 'merged' | 'locked';
  iid?: number;
  projectId?: string;
  sourceBranch?: string;
  title?: string;
}) {
  return {
    object_kind: 'merge_request',
    project: { id: Number(opts.projectId ?? PROJECT_ID) },
    object_attributes: {
      iid: opts.iid ?? 7,
      action: opts.action,
      state: opts.state ?? 'opened',
      title: opts.title ?? `Some change (${opts.identifier})`,
      source_branch: opts.sourceBranch ?? `subtask/${opts.identifier}-a-change`,
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function latestRevision(workItemId: string) {
  const rows = await db.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
  return rows[rows.length - 1]!;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('gitlabWebhookService — merge_request → status sync', () => {
  it('opened → in_review, merged → done, closed-unmerged → in_progress', async () => {
    const s = await makeScenario('mr@example.com');

    const opened = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: s.item.identifier }),
    );
    expect(opened).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'in_review',
    });
    expect(await statusOf(s.item.id)).toBe('in_review');

    // The MR row is upserted, stamped provider='gitlab', linked to the work item.
    const mrRow = await db.githubPullRequest.findFirst({ where: { number: 7 } });
    expect(mrRow).toMatchObject({
      provider: 'gitlab',
      state: 'open',
      merged: false,
      workItemId: s.item.id,
    });
    // Attribution: GitLab has no bound identity, so the owner authored the move.
    expect((await latestRevision(s.item.id)).changedById).toBe(s.user.id);

    // A closed-unmerged MR sends the item back to in_progress (the abandoned-work
    // target — there is no in_review → todo edge). Item is in_review from the open.
    const closed = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'close', state: 'closed', identifier: s.item.identifier }),
    );
    expect(closed).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'in_progress',
    });
    expect(await statusOf(s.item.id)).toBe('in_progress');

    // Reopen → back to in_review, then a merge completes the item (→ done).
    const reopened = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'reopen', state: 'opened', identifier: s.item.identifier }),
    );
    expect(reopened).toMatchObject({ outcome: 'transitioned', toStatus: 'in_review' });
    const merged = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'merge', state: 'merged', identifier: s.item.identifier }),
    );
    expect(merged).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('is idempotent: re-delivering the same opened MR is a noop', async () => {
    const s = await makeScenario('idem@example.com');
    const payload = mrPayload({ action: 'open', identifier: s.item.identifier });
    await gitlabWebhookService.handleEvent('Merge Request Hook', payload);
    const again = await gitlabWebhookService.handleEvent('Merge Request Hook', payload);
    expect(again).toMatchObject({ event: 'pull_request', outcome: 'noop', toStatus: 'in_review' });
    expect(await statusOf(s.item.id)).toBe('in_review');
  });

  it('an MR whose branch names no work item is a clean no_work_item (row still upserted)', async () => {
    const s = await makeScenario('nowi@example.com');
    const res = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({
        action: 'open',
        identifier: s.item.identifier,
        sourceBranch: 'chore/no-key',
        title: 'A change with no work-item key',
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'no_work_item' });
    // The MR row is still recorded (unlinked) so a later manual link / rename works.
    const mrRow = await db.githubPullRequest.findFirst({ where: { number: 7 } });
    expect(mrRow).toMatchObject({ provider: 'gitlab', workItemId: null });
  });

  it('an MR for an UNCONNECTED project is unknown_repo (no crash, no write)', async () => {
    const s = await makeScenario('unconn@example.com');
    const res = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: s.item.identifier, projectId: '999' }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'unknown_repo' });
    expect(await statusOf(s.item.id)).toBe('in_progress'); // untouched
  });

  it('a non-lifecycle MR action (update) is ignored — no transition', async () => {
    const s = await makeScenario('update@example.com');
    const res = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'update', identifier: s.item.identifier }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
    expect(await statusOf(s.item.id)).toBe('in_progress'); // untouched
  });

  it('a malformed merge_request payload is a clean malformed no-op', async () => {
    await makeScenario('malformed@example.com');
    // object_kind is right but object_attributes is missing the required fields.
    const res = await gitlabWebhookService.handleEvent('Merge Request Hook', {
      object_kind: 'merge_request',
      project: { id: Number(PROJECT_ID) },
      object_attributes: { iid: 7 },
    });
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'malformed' });
  });
});

describe('gitlabWebhookService — non-MR events are ignored (owned by sibling cards)', () => {
  it('a push hook is ignored here (code-graph feed is MOTIR-1476)', async () => {
    const res = await gitlabWebhookService.handleEvent('Push Hook', {
      object_kind: 'push',
      project: { id: 42 },
      ref: 'refs/heads/main',
      after: 'abc',
    });
    expect(res).toEqual({ event: 'ignored', reason: 'unhandled_event:push' });
  });

  it('a pipeline hook is ignored here (CI feedback is MOTIR-1477)', async () => {
    const res = await gitlabWebhookService.handleEvent('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: 42 },
      object_attributes: { id: 1, sha: 'abc', ref: 'main', status: 'success' },
    });
    expect(res).toEqual({ event: 'ignored', reason: 'unhandled_event:pipeline' });
  });

  it('a non-object body is a clean ignored no-op', async () => {
    expect(await gitlabWebhookService.handleEvent('Note Hook', null)).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });
});
