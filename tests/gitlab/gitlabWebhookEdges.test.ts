import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Story 7.23 · MOTIR-1479 — the GitLab webhook state machine's GUARD arms
// (mirroring `tests/github/githubWebhookEdges.test.ts` / MOTIR-896): the
// malformed / unknown / unresolvable deliveries the per-subtask suites leave
// uncovered. Every one of these must resolve to a TYPED no-op outcome — never a
// crash (a thrown error 500s the route and GitLab retries the poison delivery
// forever). The GitLab webhook has no "installation event" lifecycle (no app
// install/reconcile model) and no bound-identity table (the author is always the
// workspace owner), so the GitHub "unknown_installation" and author-resolution
// edge cases don't apply — the GitLab-specific edges are the malformed pipeline
// payloads, the unresolvable repo/item states, and the degenerate owner-less
// case.

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
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);

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

function mrPayload(opts: {
  action: string;
  identifier: string;
  iid?: number;
  projectId?: string;
  sourceBranch?: string;
  state?: 'opened' | 'closed' | 'merged' | 'locked';
}) {
  return {
    object_kind: 'merge_request',
    project: { id: Number(opts.projectId ?? PROJECT_ID) },
    object_attributes: {
      iid: opts.iid ?? 7,
      action: opts.action,
      state: opts.state ?? 'opened',
      title: `Some change (${opts.identifier})`,
      source_branch: opts.sourceBranch ?? `subtask/${opts.identifier}-a-change`,
    },
  };
}

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

async function openMr(identifier: string, iid = 7): Promise<number> {
  await gitlabWebhookService.handleEvent(
    'Merge Request Hook',
    mrPayload({ action: 'open', identifier, iid }),
  );
  return iid;
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

describe('gitlabWebhookService — malformed deliveries are typed no-ops (MOTIR-1479)', () => {
  it('a non-object body (null) is ignored as malformed', async () => {
    expect(await gitlabWebhookService.handleEvent('Merge Request Hook', null)).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });

  it('a non-object body (array) is ignored as malformed', async () => {
    expect(await gitlabWebhookService.handleEvent('Merge Request Hook', [1, 2, 3])).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });

  it('a non-object body (string) is ignored as malformed', async () => {
    expect(await gitlabWebhookService.handleEvent('Push Hook', 'not-an-object')).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });

  it('a pipeline payload missing object_attributes entirely is malformed', async () => {
    await makeScenario('edge-ma@example.com');
    const result = await gitlabWebhookService.handleEvent('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: Number(PROJECT_ID) },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a pipeline payload missing object_attributes.sha is malformed', async () => {
    await makeScenario('edge-mb@example.com');
    const result = await gitlabWebhookService.handleEvent('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: Number(PROJECT_ID) },
      object_attributes: { id: 555, ref: 'main', status: 'success' },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a pipeline payload missing object_attributes.status is malformed', async () => {
    await makeScenario('edge-mc@example.com');
    const result = await gitlabWebhookService.handleEvent('Pipeline Hook', {
      object_kind: 'pipeline',
      project: { id: Number(PROJECT_ID) },
      object_attributes: { id: 555, sha: 'sha1', ref: 'main' },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a merge_request payload missing object_attributes.source_branch is malformed', async () => {
    await makeScenario('edge-md@example.com');
    const result = await gitlabWebhookService.handleEvent('Merge Request Hook', {
      object_kind: 'merge_request',
      project: { id: Number(PROJECT_ID) },
      object_attributes: { iid: 7, action: 'open', state: 'opened' },
    });
    expect(result).toEqual({ event: 'pull_request', outcome: 'malformed' });
  });
});

describe('gitlabWebhookService — unresolvable deliveries against a real connection (MOTIR-1479)', () => {
  it('an MR on a repo outside the connection grant is unknown_repo', async () => {
    await makeScenario('edge-a@example.com');
    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ACME-1', projectId: '999999' }),
    );
    expect(result).toEqual({ event: 'pull_request', outcome: 'unknown_repo' });
  });

  it('a pipeline on a repo outside the connection grant is unknown_repo', async () => {
    await makeScenario('edge-b@example.com');
    const result = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: 7, projectId: '999999' }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'unknown_repo' });
  });

  it('a pipeline with an MR iid matching no stored MR is no_pull_request', async () => {
    await makeScenario('edge-c@example.com');
    const result = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: 42 }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'no_pull_request' });
  });

  it('a pipeline on a stored MR with NO linked work item is no_work_item', async () => {
    const s = await makeScenario('edge-d@example.com');
    const opened = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ZZZ-9', iid: 9, sourceBranch: 'chore/no-key' }),
    );
    expect(opened).toEqual({ event: 'pull_request', outcome: 'no_work_item' });
    const result = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha1', mrIid: 9 }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'no_work_item' });
    void s;
  });

  it('a pipeline on an MR whose linked work item was HARD-DELETED is no_work_item', async () => {
    const { item } = await makeScenario('edge-x@example.com');
    await openMr('ACME-1');
    await withSystemContext(async (tx) => {
      await tx.workItemRevision.deleteMany({ where: { workItemId: item.id } });
      await tx.workItem.delete({ where: { id: item.id } });
    });

    const result = await gitlabWebhookService.handleEvent(
      'Pipeline Hook',
      pipelinePayload({ status: 'success', sha: 'sha4', mrIid: 7 }),
    );
    expect(result).toMatchObject({ event: 'ci', outcome: 'no_work_item' });
  });

  it('a key whose project exists but whose item number does not → no_work_item', async () => {
    await makeScenario('edge-u@example.com');
    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ACME-999' }),
    );
    expect(result).toEqual({ event: 'pull_request', outcome: 'no_work_item' });
  });

  it('dedupes repeated key candidates and skips unknown project prefixes', async () => {
    const { item } = await makeScenario('edge-f@example.com');
    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({
        action: 'open',
        identifier: 'ZZZ-9',
        sourceBranch: 'feat/ACME-1-a-change',
      }),
    );
    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      workItemId: item.id,
      toStatus: 'in_review',
    });
  });
});

describe('gitlabWebhookService — concurrent redelivery + degenerate states (MOTIR-1479)', () => {
  it('is idempotent under concurrent redelivery of the same MR (race-safe)', async () => {
    const s = await makeScenario('edge-race@example.com');
    const payload = mrPayload({ action: 'open', identifier: s.item.identifier });

    const [a, b] = await Promise.all([
      gitlabWebhookService.handleEvent('Merge Request Hook', payload),
      gitlabWebhookService.handleEvent('Merge Request Hook', payload),
    ]);

    // Both callers race; depending on timing, both may return 'transitioned'
    // (the second reads the item status before the first's write commits) or
    // one may return 'noop' (the commit finished first). Either way the item
    // ends up at in_review and there is exactly one MR row — idempotent under
    // race.
    expect([a, b].every((r) => 'outcome' in r && r.outcome === 'transitioned')).toBe(true);
    expect(await statusOf(s.item.id)).toBe('in_review');

    // Exactly one MR row — the upsert retried on P2002 and survived the race.
    const mrRows = await db.githubPullRequest.findMany({ where: { number: 7 } });
    expect(mrRows).toHaveLength(1);
  });

  it('no workspace owner → access_denied (nothing can author the move)', async () => {
    const { user, workspace, item } = await makeScenario('edge-z@example.com');
    // Degenerate: remove the owner's membership — no principal can author the
    // transition. GitLab always uses owner (no bound identity), so this is the
    // only degenerate-author arm.
    await withSystemContext(async (tx) => {
      await tx.workspaceMembership.deleteMany({
        where: { workspaceId: workspace.id, userId: user.id },
      });
    });

    const result = await gitlabWebhookService.handleEvent(
      'Merge Request Hook',
      mrPayload({ action: 'open', identifier: 'ACME-1' }),
    );

    expect(result).toEqual({
      event: 'pull_request',
      outcome: 'access_denied',
      workItemId: item.id,
    });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});
