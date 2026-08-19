import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3007 — MERGING A SESSION-BRANCH PULL REQUEST CLOSES EVERY CARD IT CARRIES.
//
// `motir auto` integrates a whole run onto ONE session branch and opens ONE pull
// request. `sessionBranchName` (`packages/cli/src/git.ts`) deliberately keeps
// `MOTIR-<n>` out of that branch — a key in it would link the whole run to one of
// its cards — so the 1:1 resolver in `changeRequestStatusSync` found NOTHING and
// the merge closed nothing at all. Every card sat waiting for a human to remember
// `motir done --session`.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks (the
// motir-core convention). What is pinned here:
//
//   1. A session merge closes EVERY item on the branch and clears the branch.
//   2. The item the pull request TITLE names is on the branch like any other: it
//      closes exactly once, with ONE revision.
//   3. Redelivery of the same merge is a clean no-op (the branch is cleared).
//   4. A merge arriving after `motir done --session` already ran is the same no-op.
//   5. An item with no legal edge to `done` is reported and skipped — the delivery
//      still succeeds and the rest of the branch still closes.
//   6. The result names HOW MANY items were closed, not one of N.
//   7. An ordinary single-card pull request behaves exactly as it does today.
//   8. A session merge into a NON-default base is held — the branch-scoped gate
//      still runs, and nothing on the branch closes.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-session-closeout';
const REPO = { name: 'motir-core', providerRepoId: '9001', defaultBranch: 'main' };
const SESSION_BRANCH = 'motir/auto-20260819-021500';

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
        providerRepoId: REPO.providerRepoId,
        owner: 'moooon',
        name: REPO.name,
        defaultBranch: REPO.defaultBranch,
        archived: false,
      },
    ],
  });

  return { user, workspace, project, ctx };
}

/** A card the run integrated onto the session branch — `markIntegrated` is the
 *  shipped seam that stamps `session_branch` and moves the item to In Review. */
async function integratedItem(
  projectId: string,
  title: string,
  ctx: { userId: string; workspaceId: string },
  branch: string = SESSION_BRANCH,
) {
  const item = await workItemsService.createWorkItem({ projectId, kind: 'task', title }, ctx);
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await workItemsService.markIntegrated(item.id, branch, ctx);
  return item;
}

function prPayload(opts: {
  action: string;
  headRef: string;
  title: string;
  number: number;
  baseRef?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO.providerRepoId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headRef },
      base: { ref: opts.baseRef ?? REPO.defaultBranch },
      user: { id: 4242 },
    },
  };
}

const open = (headRef: string, title: string, number: number) =>
  githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', headRef, title, number }),
  );

const merge = (headRef: string, title: string, number: number, baseRef?: string) =>
  githubWebhookService.handleEvent(
    'pull_request',
    prPayload({
      action: 'closed',
      headRef,
      title,
      number,
      baseRef,
      state: 'closed',
      merged: true,
    }),
  );

async function rowOf(workItemId: string) {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!;
}

async function revisionCount(workItemId: string): Promise<number> {
  return adminDb.workItemRevision.count({ where: { workItemId } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a merged SESSION-branch pull request closes every card on the branch', () => {
  it('closes EVERY item carrying the branch and clears the branch on each', async () => {
    const { project, ctx } = await makeScenario('session-all@example.com');
    const a = await integratedItem(project.id, 'First card of the run', ctx);
    const b = await integratedItem(project.id, 'Second card of the run', ctx);
    const c = await integratedItem(project.id, 'Third card of the run', ctx);

    // The session pull request: its branch carries no key, and neither does its
    // title — exactly what `motir auto` opens.
    await open(SESSION_BRANCH, 'Run 20260819-021500', 1);
    const result = await merge(SESSION_BRANCH, 'Run 20260819-021500', 1);

    expect(result).toMatchObject({
      outcome: 'session_closed',
      sessionBranch: SESSION_BRANCH,
      sessionItems: { completed: 3, alreadyDone: 0, failed: 0 },
    });
    for (const item of [a, b, c]) {
      const row = await rowOf(item.id);
      expect(row.status).toBe('done');
      expect(row.sessionBranch).toBeNull();
    }
  });

  it('closes the item the TITLE names exactly once — one revision, not two', async () => {
    const { project, ctx } = await makeScenario('session-title@example.com');
    const named = await integratedItem(project.id, 'The card the title happens to name', ctx);
    const sibling = await integratedItem(project.id, 'A sibling on the same branch', ctx);

    const before = await revisionCount(named.id);
    await open(SESSION_BRANCH, `Run 20260819 (${named.identifier})`, 2);
    const result = await merge(SESSION_BRANCH, `Run 20260819 (${named.identifier})`, 2);

    expect(result).toMatchObject({
      outcome: 'session_closed',
      sessionItems: { completed: 2, alreadyDone: 0, failed: 0 },
    });
    expect((await rowOf(named.id)).status).toBe('done');
    expect((await rowOf(sibling.id)).status).toBe('done');
    // Exactly ONE new revision for the named card: the close-out covered it, and
    // the single-card path did not also run.
    expect(await revisionCount(named.id)).toBe(before + 1);
  });

  it('reports how many items it closed, so the outcome is legible for N cards', async () => {
    const { project, ctx } = await makeScenario('session-count@example.com');
    await integratedItem(project.id, 'One', ctx);
    await integratedItem(project.id, 'Two', ctx);

    const result = await merge(SESSION_BRANCH, 'Run 20260819-021500', 3);
    expect(result).toMatchObject({
      outcome: 'session_closed',
      sessionItems: { completed: 2, alreadyDone: 0, failed: 0 },
    });
  });
});

describe('idempotence — a redelivered merge, and a merge after the manual close-out', () => {
  it('is a clean no-op on REDELIVERY: no second transition and no second revision', async () => {
    const { project, ctx } = await makeScenario('session-redeliver@example.com');
    const a = await integratedItem(project.id, 'A card', ctx);

    await merge(SESSION_BRANCH, 'Run 20260819-021500', 4);
    const afterFirst = await revisionCount(a.id);

    const second = await merge(SESSION_BRANCH, 'Run 20260819-021500', 4);
    // The branch was cleared by the first close-out, so the delivery resolves no
    // session and no linked item — the unchanged no-op.
    expect(second).toMatchObject({ outcome: 'no_work_item' });
    expect((await rowOf(a.id)).status).toBe('done');
    expect(await revisionCount(a.id)).toBe(afterFirst);
  });

  it('is the same clean no-op when `motir done --session` already closed the branch', async () => {
    const { project, ctx } = await makeScenario('session-manual-first@example.com');
    const a = await integratedItem(project.id, 'A card closed by hand', ctx);

    await workItemsService.completeSession(SESSION_BRANCH, ctx);
    expect((await rowOf(a.id)).status).toBe('done');
    const afterManual = await revisionCount(a.id);

    const result = await merge(SESSION_BRANCH, 'Run 20260819-021500', 5);
    expect(result).toMatchObject({ outcome: 'no_work_item' });
    expect(await revisionCount(a.id)).toBe(afterManual);
  });

  it('leaves `motir done --session` working as the manual escape hatch — now a no-op after a merge', async () => {
    const { project, ctx } = await makeScenario('session-hatch@example.com');
    const a = await integratedItem(project.id, 'A card', ctx);

    await merge(SESSION_BRANCH, 'Run 20260819-021500', 6);
    const after = await workItemsService.completeSession(SESSION_BRANCH, ctx);

    // Nothing left on the branch: the close-out runs and reports an empty result.
    expect(after).toEqual({ sessionBranch: SESSION_BRANCH, results: [] });
    expect((await rowOf(a.id)).status).toBe('done');
  });
});

describe('a card that cannot reach done is reported and skipped, never fatal', () => {
  it('closes the rest of the branch and still returns a delivery result', async () => {
    const { project, ctx } = await makeScenario('session-illegal@example.com');
    const ok = await integratedItem(project.id, 'A card that can complete', ctx);
    const stuck = await integratedItem(project.id, 'A card moved back to To Do', ctx);
    // `todo` has no edge to `done` in the default workflow, and moving back there
    // does not clear the session branch — so the item is still on the run and
    // still cannot be completed by it. (`in_review → todo` is itself illegal, so
    // this walks the legal path a person would: back to Blocked, then To Do.)
    await workItemsService.updateStatus(stuck.id, 'blocked', ctx);
    await workItemsService.updateStatus(stuck.id, 'todo', ctx);
    expect((await rowOf(stuck.id)).sessionBranch).toBe(SESSION_BRANCH);

    const result = await merge(SESSION_BRANCH, 'Run 20260819-021500', 7);

    expect(result).toMatchObject({
      outcome: 'session_closed',
      sessionItems: { completed: 1, alreadyDone: 0, failed: 1 },
    });
    expect((await rowOf(ok.id)).status).toBe('done');
    expect((await rowOf(stuck.id)).status).toBe('todo');
    // Reported and skipped, not silently swallowed: the item keeps its branch, so
    // a later `motir done --session` (or a fix to its status) can still close it.
    expect((await rowOf(stuck.id)).sessionBranch).toBe(SESSION_BRANCH);
  });
});

describe('the single-card path is untouched', () => {
  it('an ordinary pull request still closes exactly its own card', async () => {
    const { project, ctx } = await makeScenario('single-card@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'An ordinary card' },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);

    const headRef = `subtask/${item.identifier}-an-ordinary-card`;
    await open(headRef, `feat: a change (${item.identifier})`, 8);
    // An OPEN pull request means `implemented` since MOTIR-3005 — the code
    // exists and CI has not spoken for it.
    expect((await rowOf(item.id)).status).toBe('implemented');

    const result = await merge(headRef, `feat: a change (${item.identifier})`, 8);
    expect(result).toMatchObject({
      outcome: 'transitioned',
      workItemId: item.id,
      toStatus: 'done',
    });
    expect((await rowOf(item.id)).status).toBe('done');
  });

  it('a pull request that names no work item is still `no_work_item`', async () => {
    await makeScenario('single-none@example.com');
    const result = await merge('chore/tidy-up', 'chore: tidy up', 9);
    expect(result).toMatchObject({ outcome: 'no_work_item' });
  });
});

describe('the branch-scoped gate still runs on a session delivery', () => {
  it('HOLDS the whole close-out when the session merge did not land on the trunk', async () => {
    const { project, ctx } = await makeScenario('session-stranded@example.com');
    const a = await integratedItem(project.id, 'A card on a stacked run', ctx);
    const b = await integratedItem(project.id, 'Another card on it', ctx);

    const result = await merge(SESSION_BRANCH, 'Run 20260819-021500', 10, 'release/next');

    expect(result).toMatchObject({
      outcome: 'deferred_non_default_base',
      sessionBranch: SESSION_BRANCH,
    });
    for (const item of [a, b]) {
      const row = await rowOf(item.id);
      expect(row.status).toBe('in_review');
      expect(row.sessionBranch).toBe(SESSION_BRANCH);
    }
  });
});
