import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { GithubNotConnectedError, GithubPullRequestNotFoundError } from '@/lib/github/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-1596 — the EXPLICIT item→PR link (the manual override of
// the MOTIR-892 auto-resolver). Covers the service branches (happy link, takeover
// move, cross-workspace, unknown PR, disconnected workspace, candidate search
// annotation/exclusion) AND the correctness invariant the flag exists for: a
// manual link is STICKY against the webhook resolver and still drives the status
// sync. Real Postgres — the writes go through the actual webhook + service paths.

const PASSWORD = 'hunter2hunter2';

async function makeScenario(opts: {
  email: string;
  installationId: string;
  repoProviderId: string;
  withInstallation?: boolean;
}) {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Own',
  });
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
  if (opts.withInstallation !== false) {
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: opts.installationId,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: opts.repoProviderId,
          owner: 'moooon',
          name: 'acme',
          defaultBranch: 'main',
        },
      ],
    });
  }
  return { user, workspace, project, ctx };
}

function prEvent(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
  state?: string;
  merged?: boolean;
  action?: string;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: { id: opts.installationId, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repoProviderId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headBranch },
      user: { id: 4242 },
    },
  };
}

/** Ingest a PR via the real webhook and return its internal row id. A branch that
 *  does NOT name any item key leaves it UNLINKED (the manual-link starting point). */
async function ingestPr(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
}): Promise<string> {
  await githubWebhookService.handleEvent('pull_request', prEvent(opts));
  const row = await db.githubPullRequest.findFirst({ where: { number: opts.number } });
  return row!.id;
}

const INST_A = 'inst-explicit-a';
const REPO_A = '9101';
const INST_B = 'inst-explicit-b';
const REPO_B = '9202';

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('githubPullRequestService.linkPullRequest — the explicit override (MOTIR-1596)', () => {
  it('links an unresolved PR to the item (sets workItemId + linkedManually), returns the DTO', async () => {
    const s = await makeScenario({
      email: 'link-happy@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Rate-limit the API' },
      s.ctx,
    );
    // A PR whose branch never names the item's key — the resolver skipped it.
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 12,
      headBranch: 'feature/unrelated-branch',
      title: 'Add per-route throttling',
    });
    const before = await db.githubPullRequest.findUnique({ where: { id: prId } });
    expect(before?.workItemId).toBeNull();

    const dto = await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);
    expect(dto).toMatchObject({ number: 12, repo: 'moooon/acme', linkedManually: true });

    const after = await db.githubPullRequest.findUnique({ where: { id: prId } });
    expect(after?.workItemId).toBe(item.id);
    expect(after?.linkedManually).toBe(true);
  });

  it('a takeover MOVES the link to the picking item (single FK, no confirm)', async () => {
    const s = await makeScenario({
      email: 'link-takeover@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const itemA = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item A' },
      s.ctx,
    );
    const itemB = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item B' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 15,
      headBranch: 'feature/shared',
      title: 'Shared change',
    });
    await githubPullRequestService.linkPullRequest(itemA.id, prId, s.ctx);
    await githubPullRequestService.linkPullRequest(itemB.id, prId, s.ctx);

    const row = await db.githubPullRequest.findUnique({ where: { id: prId } });
    expect(row?.workItemId).toBe(itemB.id);
    expect(row?.linkedManually).toBe(true);
  });

  it('a cross-workspace PR is rejected (no existence leak)', async () => {
    // ws1 owns the PR (its installation + repo) — the object itself isn't needed.
    await makeScenario({
      email: 'xws-1@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const ws2 = await makeScenario({
      email: 'xws-2@example.com',
      installationId: INST_B,
      repoProviderId: REPO_B,
    });
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 21,
      headBranch: 'feature/ws1',
      title: 'WS1 PR',
    });
    const item2 = await workItemsService.createWorkItem(
      { projectId: ws2.project.id, kind: 'task', title: 'WS2 item' },
      ws2.ctx,
    );
    await expect(
      githubPullRequestService.linkPullRequest(item2.id, prId, ws2.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
  });

  it('an unknown PR id is rejected', async () => {
    const s = await makeScenario({
      email: 'unknown-pr@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    await expect(
      githubPullRequestService.linkPullRequest(item.id, 'pr-does-not-exist', s.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
  });
});

describe('githubPullRequestService.searchLinkCandidates (MOTIR-1596)', () => {
  it('returns matches, annotates a PR linked elsewhere, and excludes the current item’s PRs', async () => {
    const s = await makeScenario({
      email: 'candidates@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const itemA = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Alpha' },
      s.ctx,
    );
    const itemB = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Beta' },
      s.ctx,
    );
    // PR#30 auto-links to itemA (branch names it); PR#40 is unlinked.
    await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 30,
      headBranch: `feat/${itemA.identifier}-rate`,
      title: 'Rate limiting alpha',
    });
    const pr40 = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 40,
      headBranch: 'feat/beta-rate',
      title: 'Rate limiting beta',
    });

    // Searching from itemB: both match "rate"; #30 carries the takeover chip.
    let results = await githubPullRequestService.searchLinkCandidates(itemB.id, 'rate', s.ctx);
    const byNumber = Object.fromEntries(results.map((r) => [r.number, r]));
    expect(byNumber[30]?.linkedTo).toBe(itemA.identifier);
    expect(byNumber[40]?.linkedTo).toBeNull();

    // Search by NUMBER also resolves.
    results = await githubPullRequestService.searchLinkCandidates(itemB.id, '40', s.ctx);
    expect(results.map((r) => r.number)).toContain(40);

    // Once #40 is linked to itemB, it drops out of itemB's own candidate list.
    await githubPullRequestService.linkPullRequest(itemB.id, pr40, s.ctx);
    results = await githubPullRequestService.searchLinkCandidates(itemB.id, 'rate', s.ctx);
    expect(results.map((r) => r.number)).not.toContain(40);
    expect(results.map((r) => r.number)).toContain(30);
  });

  it('a short query returns [] (the type-to-search prompt)', async () => {
    const s = await makeScenario({
      email: 'short-q@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    expect(await githubPullRequestService.searchLinkCandidates(item.id, 'a', s.ctx)).toEqual([]);
  });

  it('a disconnected workspace throws GithubNotConnectedError', async () => {
    const s = await makeScenario({
      email: 'disconnected@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
      withInstallation: false,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Item' },
      s.ctx,
    );
    await expect(
      githubPullRequestService.searchLinkCandidates(item.id, 'rate', s.ctx),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
  });

  it('a cross-workspace current item is rejected', async () => {
    const ws1 = await makeScenario({
      email: 'cand-xws-1@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const ws2 = await makeScenario({
      email: 'cand-xws-2@example.com',
      installationId: INST_B,
      repoProviderId: REPO_B,
    });
    const item1 = await workItemsService.createWorkItem(
      { projectId: ws1.project.id, kind: 'task', title: 'WS1 item' },
      ws1.ctx,
    );
    await expect(
      githubPullRequestService.searchLinkCandidates(item1.id, 'rate', ws2.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('a manual link is STICKY against the webhook resolver (MOTIR-1596)', () => {
  it('survives a later PR event whose branch never names the key', async () => {
    const s = await makeScenario({
      email: 'sticky@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Manual target' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 55,
      headBranch: 'feature/no-key-here',
      title: 'Unnamed PR',
    });
    await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);

    // A later delivery (reopened) whose branch STILL names no key: the resolver
    // finds nothing, but the manual link is preserved — NOT cleared to null.
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: INST_A,
        repoProviderId: REPO_A,
        number: 55,
        headBranch: 'feature/no-key-here',
        title: 'Unnamed PR (reopened)',
        action: 'reopened',
      }),
    );
    const row = await db.githubPullRequest.findUnique({ where: { id: prId } });
    expect(row?.workItemId).toBe(item.id);
    expect(row?.linkedManually).toBe(true);
  });

  it('drives the status sync on merge (merged → Done via the manual link)', async () => {
    const s = await makeScenario({
      email: 'sticky-merge@example.com',
      installationId: INST_A,
      repoProviderId: REPO_A,
    });
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Merge target' },
      s.ctx,
    );
    const prId = await ingestPr({
      installationId: INST_A,
      repoProviderId: REPO_A,
      number: 66,
      headBranch: 'feature/unnamed-merge',
      title: 'Unnamed merge PR',
    });
    await githubPullRequestService.linkPullRequest(item.id, prId, s.ctx);
    // Move to In Review so the merge's Done transition is workflow-legal.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);

    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: INST_A,
        repoProviderId: REPO_A,
        number: 66,
        headBranch: 'feature/unnamed-merge',
        title: 'Unnamed merge PR',
        action: 'closed',
        state: 'closed',
        merged: true,
      }),
    );
    const moved = await db.workItem.findUnique({ where: { id: item.id } });
    expect(moved?.status).toBe('done');
    // The link stays manual after the merge delivery.
    const row = await db.githubPullRequest.findUnique({ where: { id: prId } });
    expect(row?.linkedManually).toBe(true);
    expect(row?.workItemId).toBe(item.id);
  });
});
