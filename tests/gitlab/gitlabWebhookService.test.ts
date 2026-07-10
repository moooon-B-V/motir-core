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

/** A GitLab `pipeline` webhook body — the CI analog of GitHub's check event. Carries
 *  the associated MR iid on `merge_request.iid` (the strongest link) and the branch
 *  on `object_attributes.ref` (the fallback). `status` is a GitLab pipeline status
 *  (`success` / `failed` / `running` / `skipped` / …). */
function pipelinePayload(opts: {
  status: string;
  sha?: string;
  mrIid?: number | null;
  ref?: string;
  projectId?: string;
}) {
  return {
    object_kind: 'pipeline',
    project: { id: Number(opts.projectId ?? PROJECT_ID) },
    object_attributes: {
      id: 555,
      sha: opts.sha ?? 'sha1',
      ref: opts.ref ?? 'main',
      status: opts.status,
    },
    merge_request: opts.mrIid === null ? undefined : { iid: opts.mrIid ?? 7 },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function commentsOn(workItemId: string) {
  return db.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}
async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}

/** Open the MR (through the status-sync hook) so its change-request row is stored
 *  and linked to the work item by the source branch — mirrors reality: the MR opens
 *  (link) → then its pipeline runs against it. Returns the MR iid. */
async function openMr(identifier: string, iid = 7): Promise<number> {
  await gitlabWebhookService.handleEvent(
    'Merge Request Hook',
    mrPayload({ action: 'open', identifier, iid }),
  );
  return iid;
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

describe('gitlabWebhookService — push no-ops + malformed input', () => {
  it('a push for an UNCONNECTED project is a clean no-op (code-graph feed is MOTIR-1476)', async () => {
    // Push is now DISPATCHED (the code-graph feed, MOTIR-1476); a push for a project
    // not connected in any workspace resolves to a clean `unknown_repo` no-op — the
    // graceful degradation for a missing repo. The default-branch → refresh-enqueue
    // happy path + the ignored-ref paths live in `gitlabCodeGraphFeed.test.ts`.
    const res = await gitlabWebhookService.handleEvent('Push Hook', {
      object_kind: 'push',
      project: { id: 42 },
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
    });
    expect(res).toEqual({ event: 'push', outcome: 'unknown_repo' });
  });

  it('a non-object body is a clean ignored no-op', async () => {
    expect(await gitlabWebhookService.handleEvent('Note Hook', null)).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });
});

// Story 7.23 · MOTIR-1477 — a GitLab `pipeline` hook drives the SAME shared
// CI-feedback consumer (`applyCiStatusFeedback`) GitHub's check events drive:
// a terminal pipeline status → a passing note / failure summary on the linked
// work item + its `ciState` verification signal; idempotent redelivery; the
// pending-recorded + neutral + no-op paths; attribution to the workspace owner
// (GitLab has no bound identity). Mirrors `tests/github/githubCiFeedback.test.ts`.
describe('gitlabWebhookService — pipeline → CI feedback (MOTIR-1477)', () => {
  it('a successful pipeline posts a passing note and marks the item verified', async () => {
    const s = await makeScenario('pl-pass@example.com');
    const iid = await openMr(s.item.identifier);

    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: iid }),
    );
    expect(res).toMatchObject({
      event: 'ci',
      outcome: 'verified',
      workItemId: s.item.id,
      ciState: 'passing',
    });
    expect(await ciStateOf(s.item.id)).toBe('passing');

    const comments = await commentsOn(s.item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI passing');
    expect(comments[0]!.bodyMd).toContain('merge request'); // host-appropriate noun

    const checkRows = await db.githubCheckRun.findMany();
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0]).toMatchObject({
      conclusion: 'success',
      commitSha: 'sha1',
      checkName: 'pipeline',
    });
    expect(checkRows[0]!.feedbackCommentId).toBe(comments[0]!.id);
  });

  it('a failed pipeline posts the failure summary + MR pipelines link and flips to not-ready', async () => {
    const s = await makeScenario('pl-fail@example.com');
    const iid = await openMr(s.item.identifier);

    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'failed', sha: 'sha1', mrIid: iid }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'failed', ciState: 'failing' });
    expect(await ciStateOf(s.item.id)).toBe('failing');

    const comments = await commentsOn(s.item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI failed');
    expect(comments[0]!.bodyMd).toContain('/-/merge_requests/7/pipelines'); // the "view checks" link
  });

  it('is idempotent under REDELIVERY — the same pipeline status never duplicates the comment', async () => {
    const s = await makeScenario('pl-idem@example.com');
    const iid = await openMr(s.item.identifier);
    const payload = pipelinePayload({ status: 'success', sha: 'sha1', mrIid: iid });

    expect(await gitlabWebhookService.handleEvent('Pipeline Hook', payload)).toMatchObject({
      outcome: 'verified',
    });
    expect(await gitlabWebhookService.handleEvent('Pipeline Hook', payload)).toMatchObject({
      outcome: 'noop',
    });
    expect(await commentsOn(s.item.id)).toHaveLength(1);
    expect(await db.githubCheckRun.count()).toBe(1);
  });

  it('resolves the MR by BRANCH when the pipeline carries no merge_request', async () => {
    const s = await makeScenario('pl-branch@example.com');
    // The MR opened on this source branch; the pipeline omits merge_request but
    // carries the ref, so the branch fallback links it.
    await openMr(s.item.identifier);
    const branch = `subtask/${s.item.identifier}-a-change`;

    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: null, ref: branch }),
    );
    expect(res).toMatchObject({ outcome: 'verified', workItemId: s.item.id });
    expect(await ciStateOf(s.item.id)).toBe('passing');
  });

  it('an in-flight (running) pipeline is RECORDED as pending — no comment, no signal', async () => {
    const s = await makeScenario('pl-pending@example.com');
    const iid = await openMr(s.item.identifier);

    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'running', sha: 'sha1', mrIid: iid }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    const rows = await db.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ conclusion: 'pending', feedbackCommentId: null });
    expect(await commentsOn(s.item.id)).toHaveLength(0);
    expect(await ciStateOf(s.item.id)).toBeNull();
  });

  it('a skipped/manual pipeline (neutral) stays a full no-op — nothing recorded', async () => {
    const s = await makeScenario('pl-neutral@example.com');
    const iid = await openMr(s.item.identifier);

    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'skipped', sha: 'sha1', mrIid: iid }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'ignored_pending' });
    expect(await db.githubCheckRun.count()).toBe(0);
    expect(await commentsOn(s.item.id)).toHaveLength(0);
    expect(await ciStateOf(s.item.id)).toBeNull();
  });

  it('a pipeline for an MR with NO linked work item is a clean no-op', async () => {
    const s = await makeScenario('pl-nowi@example.com');
    // An MR whose branch names no work item opens (row stored, unlinked) as iid 9.
    await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({
        action: 'open',
        identifier: s.item.identifier,
        iid: 9,
        sourceBranch: 'chore/no-key',
        title: 'no key here',
      }),
    );
    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'shaX', mrIid: 9 }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'no_work_item' });
    expect(await db.githubCheckRun.count()).toBe(0);
    expect(await ciStateOf(s.item.id)).toBeNull();
  });

  it('a pipeline for an UNCONNECTED project is unknown_repo (no crash, no write)', async () => {
    const s = await makeScenario('pl-unconn@example.com');
    await openMr(s.item.identifier);
    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: 7, projectId: '999' }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'unknown_repo' });
    expect(await db.githubCheckRun.count()).toBe(0);
  });

  it('a pipeline before any MR is stored is a clean no_pull_request no-op', async () => {
    const s = await makeScenario('pl-nopr@example.com');
    // No MR opened → no change-request row to resolve the pipeline against.
    const res = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: 7 }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'no_pull_request' });
    expect(await db.githubCheckRun.count()).toBe(0);
    expect(await ciStateOf(s.item.id)).toBeNull();
  });
});
