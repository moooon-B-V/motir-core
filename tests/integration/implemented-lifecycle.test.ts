import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3008 — THE STORY'S INTEGRATION SEAMS.
//
// Every subtask of MOTIR-2999 tests its own half against mocked neighbours. This
// suite drives one subtask's REAL output through the next's REAL consumer, on a
// real Postgres with the real workflow the real migration produces. What it is
// for is the interactions no single card's tests can see:
//
//  1. THE TWO-WRITER RACE. The agent reports `implemented` and a PR-opened
//     delivery lands moments later. Both write the status, neither knows about
//     the other, and their order is decided by the network. Asserted in BOTH
//     orders, because "it works in the order I imagined" is exactly the bug.
//  2. THE FULL FORWARD PATH — every hop, in sequence, with the status asserted
//     at each: the run's report, the PR-opened delivery, a pending aggregate, a
//     terminal green, the merge.
//  3. GREEN-THEN-MERGE ON A SESSION BRANCH — the N-card shape, where one green
//     promotes all of them and one merge closes all of them.
//
// The per-card unit suites are `tests/workflows/implemented-status`,
// `tests/github/ciGreenPromotion` and `tests/github/changeRequestSessionCloseOut`.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-lifecycle';
const REPO_PROVIDER_ID = '9100';

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
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

function pr(opts: {
  action: string;
  headRef: string;
  number: number;
  merged?: boolean;
  state?: 'open' | 'closed';
  baseRef?: string;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Work (${opts.headRef})`,
      head: { ref: opts.headRef },
      base: { ref: opts.baseRef ?? 'main' },
      user: { id: 4242 },
    },
  };
}

function checks(opts: {
  conclusion: string | null;
  headSha: string;
  number: number;
  status?: string;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number: opts.number }],
    },
  };
}

const openPr = (headRef: string, number: number) =>
  githubWebhookService.handleEvent('pull_request', pr({ action: 'opened', headRef, number }));
const mergePr = (headRef: string, number: number) =>
  githubWebhookService.handleEvent(
    'pull_request',
    pr({ action: 'closed', headRef, number, state: 'closed', merged: true }),
  );
const ci = (o: Parameters<typeof checks>[0]) =>
  githubWebhookService.handleEvent('check_suite', checks(o));

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}
async function branchOf(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.sessionBranch;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the two-writer race — the agent and the webhook both say "finished"', () => {
  it('lands at implemented when the AGENT writes first', async () => {
    const s = await makeScenario('race-agent-first@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Raced' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    // The agent reports…
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    // …and the PR-opened delivery arrives a moment later.
    const delivery = await openPr(`subtask/${item.identifier}-work`, 30);

    expect(await statusOf(item.id)).toBe('implemented');
    // The delivery is a NO-OP, not a second transition: both writers name the
    // same state, which is the whole point of MOTIR-3005.
    expect(delivery).toMatchObject({ outcome: 'noop', toStatus: 'implemented' });
  });

  it('lands at implemented when the WEBHOOK writes first', async () => {
    const s = await makeScenario('race-hook-first@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Raced' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);

    await openPr(`subtask/${item.identifier}-work`, 31);
    expect(await statusOf(item.id)).toBe('implemented');

    // The agent's own transition, arriving second, is an idempotent no-op rather
    // than an illegal move — `implemented → implemented` short-circuits.
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('records ONE revision either way — the second writer adds nothing', async () => {
    const s = await makeScenario('race-revisions@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Raced' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    const before = await adminDb.workItemRevision.count({ where: { workItemId: item.id } });

    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    await openPr(`subtask/${item.identifier}-work`, 32);

    expect(await adminDb.workItemRevision.count({ where: { workItemId: item.id } })).toBe(
      before + 1,
    );
  });
});

describe('the full forward path, hop by hop', () => {
  it('in_progress → implemented → (pending) → in_review → done', async () => {
    const s = await makeScenario('forward@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'The whole path' },
      s.ctx,
    );
    const head = `subtask/${item.identifier}-work`;

    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    expect(await statusOf(item.id)).toBe('in_progress');

    // The run reports.
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    expect(await statusOf(item.id)).toBe('implemented');

    // The pull request opens — same state, no move.
    await openPr(head, 33);
    expect(await statusOf(item.id)).toBe('implemented');

    // Checks START: recorded, but a non-terminal aggregate promotes nothing.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha1', number: 33 });
    expect(await statusOf(item.id)).toBe('implemented');

    // Checks GO GREEN: the only hop nobody at a terminal performs.
    await ci({ conclusion: 'success', headSha: 'sha1', number: 33 });
    expect(await statusOf(item.id)).toBe('in_review');

    // A human merges.
    await mergePr(head, 33);
    expect(await statusOf(item.id)).toBe('done');
  });

  it('a RED build holds the card at implemented, and a later green releases it', async () => {
    const s = await makeScenario('forward-red@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'Red then green' },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await openPr(`subtask/${item.identifier}-work`, 34);

    await ci({ conclusion: 'failure', headSha: 'sha1', number: 34 });
    expect(await statusOf(item.id)).toBe('implemented');

    // The fix is pushed: a new sha, and this one passes.
    await ci({ conclusion: 'success', headSha: 'sha2', number: 34 });
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('green-then-merge on a session branch — the N-card shape', () => {
  it('one green promotes every card, and one merge closes every card', async () => {
    const s = await makeScenario('session-n@example.com');
    const branch = 'motir/auto-20260819-120000';
    const items = [];
    for (const title of ['One', 'Two', 'Three']) {
      const item = await workItemsService.createWorkItem(
        { projectId: s.project.id, kind: 'task', title },
        s.ctx,
      );
      await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
      await workItemsService.markIntegrated(item.id, branch, s.ctx);
      items.push(item);
    }
    await openPr(branch, 35);
    for (const item of items) expect(await statusOf(item.id)).toBe('implemented');

    await ci({ conclusion: 'success', headSha: 'sha-s', number: 35 });
    for (const item of items) expect(await statusOf(item.id)).toBe('in_review');

    await mergePr(branch, 35);
    for (const item of items) {
      expect(await statusOf(item.id)).toBe('done');
      // The done-invariant: a closed card carries no lineage for a dependent to
      // inherit (7.8.11), and the close-out is what clears it.
      expect(await branchOf(item.id)).toBeNull();
    }
  });
});

describe('cross-tenant isolation on the delivery paths', () => {
  it('a delivery for one workspace never touches another workspace’s card', async () => {
    // Both tenants have a project keyed ACME and an item at the same identifier;
    // only the repo row says whose the delivery is (MOTIR-1931).
    const mine = await makeScenario('tenant-a@example.com');
    const theirs = await makeScenario('tenant-b@example.com');

    const ours = await workItemsService.createWorkItem(
      { projectId: mine.project.id, kind: 'task', title: 'Ours' },
      mine.ctx,
    );
    const others = await workItemsService.createWorkItem(
      { projectId: theirs.project.id, kind: 'task', title: 'Theirs' },
      theirs.ctx,
    );
    expect(ours.identifier).toBe(others.identifier);

    await workItemsService.updateStatus(ours.id, 'in_progress', mine.ctx);
    await workItemsService.updateStatus(others.id, 'in_progress', theirs.ctx);

    // The installation + repo the delivery names belongs to the SECOND tenant
    // (the last `persistInstallation` wins the provider repo id), so the first
    // tenant's identically-keyed card must not move.
    await openPr(`subtask/${others.identifier}-work`, 36);

    expect(await statusOf(others.id)).toBe('implemented');
    expect(await statusOf(ours.id)).toBe('in_progress');
  });
});
