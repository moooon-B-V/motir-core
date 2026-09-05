import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';
import { deliveredItemIds, linkPr } from '../helpers/prLink';

// ⚠️ MOTIR-3674 — every test below that means *this pull request delivers this
// card* now LINKS it (`linkFor`, the `link_pull_request` service the agent calls)
// instead of naming the key in the head ref and letting the sync parse it out.
// The parse is retired: the branch and the title are labels, and a pull request
// nobody linked resolves `no_work_item` however many keys its text contains. The
// linking call goes BEFORE the first delivery, which is also the real ordering —
// a run links the moment `gh pr create` returns, before GitHub's webhook lands.
//
// Story 7.10 · MOTIR-892 — the inbound webhook status-sync state machine, against
// a real Postgres (the motir-core convention). Covers: the PR-lifecycle →
// workflow-status transitions through the SHIPPED workItemsService, actor
// attribution (bound author vs the owner fallback), idempotency under a CONCURRENT
// redelivery race, the installation grant mirror (reconcile / remove / unbound),
// and the no-crash paths (no linked work item, an illegal transition).

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-1';
const REPO_PROVIDER_ID = '555';

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** A workspace + project + a work item already moved to `in_progress` (so a
 *  PR-opened → implemented is a legal transition), plus a seeded installation + repo. */
async function makeScenario(email: string) {
  const { user, workspace } = await makeWorkspace(email);
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
  return { user, workspace, project, item, ctx };
}

/** A GitHub `pull_request` delivery body, referencing a work item by its head ref. */
function prPayload(opts: {
  action: string;
  identifier: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  authorGithubUserId?: number;
  installationId?: string;
  repoId?: number;
  /** The base the PR merges INTO — the trunk gate reads it (MOTIR-1873). */
  baseRef?: string;
}) {
  return {
    action: opts.action,
    installation: {
      id: opts.installationId ?? INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `feat/${opts.identifier}-a-change` },
      base: { ref: opts.baseRef ?? 'main' },
      user: { id: opts.authorGithubUserId ?? 4242 },
    },
  };
}

/** The link a run writes immediately after `gh pr create` — since MOTIR-3674 the
 *  ONLY association a pull request has. Mirrors `prPayload`'s refs exactly, so a
 *  test says once which pull request delivers the item and the deliveries then
 *  read as they always did. */
async function linkFor(
  s: { item: { id: string; identifier: string }; project: { id: string }; ctx: ServiceCtx },
  opts: { number?: number; repo?: string } = {},
) {
  return linkPr(
    {
      workItemId: s.item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: opts.repo ?? 'acme',
      number: opts.number ?? 7,
      headRef: `feat/${s.item.identifier}-a-change`,
      baseRef: 'main',
      title: `Some change (${s.item.identifier})`,
    },
    s.ctx,
  );
}

interface ServiceCtx {
  userId: string;
  workspaceId: string;
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function statusRevisions(workItemId: string) {
  return adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubWebhookService — pull_request → status sync', () => {
  it('opened → implemented, closed+merged → done, closed+unmerged → in_progress', async () => {
    const s = await makeScenario('pr@example.com');
    await linkFor(s);

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    expect(opened).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'implemented',
    });
    expect(await statusOf(s.item.id)).toBe('implemented');

    // The PR row is upserted, and the DELIVERY says which card it carries — the
    // row itself holds no association since MOTIR-3757.
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(prRow).toMatchObject({ state: 'open', merged: false });
    expect(await deliveredItemIds(prRow.id)).toEqual([s.item.id]);

    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );
    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('closed WITHOUT merging returns the item to in_progress (the abandoned-work path)', async () => {
    const s = await makeScenario('unmerged@example.com');
    await linkFor(s);
    // Open first so the item sits at implemented.
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    expect(await statusOf(s.item.id)).toBe('implemented');

    const closed = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: false,
      }),
    );
    expect(closed).toMatchObject({ outcome: 'transitioned', toStatus: 'in_progress' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('a REOPENED pull request returns the item to implemented (MOTIR-3005)', async () => {
    // Closing without merging puts the card back at `in_progress`; reopening
    // re-delivers `opened`, and `in_progress → implemented` is a legal edge, so
    // the card lands back where an open pull request belongs.
    const s = await makeScenario('reopened@example.com');
    await linkFor(s);
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: false,
      }),
    );
    expect(await statusOf(s.item.id)).toBe('in_progress');

    const reopened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'reopened', identifier: s.item.identifier }),
    );
    expect(reopened).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('an opened delivery for a card with NO legal edge to implemented leaves it alone (MOTIR-3005)', async () => {
    // `todo → implemented` is deliberately not an edge — a card nobody started
    // has nothing built. The delivery must still COMPLETE: a webhook is never
    // failed by an unreachable transition, or the host retries it forever.
    // `classifyTransitionError` in `changeRequestStatusSync` is where that is
    // caught, and it reports the outcome rather than swallowing it silently.
    const s = await makeScenario('unreachable@example.com');
    await linkFor(s);
    // The fixture leaves the item at `in_progress`; send it back to the queue.
    await workItemsService.updateStatus(s.item.id, 'todo', s.ctx);
    expect(await statusOf(s.item.id)).toBe('todo');

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    expect(opened).toMatchObject({
      event: 'pull_request',
      outcome: 'illegal_transition',
      toStatus: 'implemented',
    });
    expect(await statusOf(s.item.id)).toBe('todo');
    // The pull-request row is still mirrored and linked — the status is what did
    // not move, not the delivery.
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(prRow).toMatchObject({ state: 'open' });
    expect(await deliveredItemIds(prRow.id)).toEqual([s.item.id]);
  });

  it('records the transition in the activity log as the BOUND author when the PR author is a member', async () => {
    const s = await makeScenario('bound@example.com');
    await linkFor(s);
    // A second workspace member who has connected their GitHub identity.
    const dev = await usersService.createUser({
      email: 'dev@example.com',
      password: PASSWORD,
      name: 'Dev',
    });
    // MOTIR-2868: `withSystemContext` does NOT admit the membership write.
    // Neither tenant-root membership policy has a `system_admin` arm at all —
    // `membership_insert_active_or_bootstrap` is `"workspaceId" =
    // app.workspace_id` OR the bootstrap-slug arm, and nothing else — so under
    // `motir_app` the row was refused.
    //
    // The two writes below want DIFFERENT GUCs, which is why this is
    // `withWorkspaceContext` and not the workspace-only helper:
    // `workspace_membership` gates on `app.workspace_id`, while
    // `github_identity_owner_or_system` gates on `user_id = app.user_id` (its
    // other arm is the system one). Binding only the workspace fixes the first
    // and breaks the second. Enumerate the arms per TABLE, not per transaction.
    // (Same client as before; only the context changed.)
    await withWorkspaceContext({ userId: dev.id, workspaceId: s.workspace.id }, async (tx) => {
      await workspaceMembershipRepository.create(
        { userId: dev.id, workspaceId: s.workspace.id, role: 'member' },
        tx,
      );
      await githubIdentityRepository.upsertForUser(
        {
          userId: dev.id,
          githubUserId: '77',
          githubLogin: 'dev',
          avatarUrl: null,
          accessTokenEncrypted: 'x',
        },
        tx,
      );
    });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, authorGithubUserId: 77 }),
    );

    const revs = await statusRevisions(s.item.id);
    const last = revs.at(-1)!;
    expect(last.diff).toMatchObject({ status: { to: 'implemented' } });
    expect(last.changedById).toBe(dev.id); // the bound author, not the owner
  });

  it('falls back to the workspace owner when the PR author is not a bound member', async () => {
    const s = await makeScenario('fallback@example.com');
    await linkFor(s);
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, authorGithubUserId: 999999 }),
    );
    const last = (await statusRevisions(s.item.id)).at(-1)!;
    expect(last.diff).toMatchObject({ status: { to: 'implemented' } });
    expect(last.changedById).toBe(s.user.id); // the workspace owner
  });

  it('is idempotent under a CONCURRENT redelivery race — one transition, one PR row', async () => {
    const s = await makeScenario('race@example.com');
    await linkFor(s);
    const payload = prPayload({ action: 'opened', identifier: s.item.identifier });

    // Two identical deliveries at once (GitHub redelivers): the unique-(repo,number)
    // upsert race is caught (P2002 → converge), and the row-locked updateStatus
    // serializes so exactly ONE transition is recorded.
    const results = await Promise.all([
      githubWebhookService.handleEvent('pull_request', payload),
      githubWebhookService.handleEvent('pull_request', payload),
    ]);
    for (const r of results) expect(r.event).toBe('pull_request');

    expect(await statusOf(s.item.id)).toBe('implemented');
    const prRows = await adminDb.githubPullRequest.findMany({ where: { number: 7 } });
    expect(prRows).toHaveLength(1);
    const inReviewRevs = (await statusRevisions(s.item.id)).filter(
      (r) => (r.diff as { status?: { to?: string } }).status?.to === 'implemented',
    );
    expect(inReviewRevs).toHaveLength(1);
  });

  it('a sequential redelivery of the same event is a no-op (already in the target)', async () => {
    const s = await makeScenario('redeliver@example.com');
    await linkFor(s);
    const payload = prPayload({ action: 'opened', identifier: s.item.identifier });
    await githubWebhookService.handleEvent('pull_request', payload);
    const again = await githubWebhookService.handleEvent('pull_request', payload);
    expect(again).toMatchObject({ outcome: 'noop', toStatus: 'implemented' });
  });

  it('a PR that references no work item upserts the PR row (null link) and does not transition', async () => {
    const s = await makeScenario('nowi@example.com');
    const res = await githubWebhookService.handleEvent('pull_request', {
      ...prPayload({ action: 'opened', identifier: 'ACME' }),
      pull_request: {
        number: 9,
        state: 'open',
        merged: false,
        title: 'no key here',
        head: { ref: 'feat/misc' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'no_work_item' });
    expect(await statusOf(s.item.id)).toBe('in_progress'); // untouched
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 9 } });
    // Title is captured on upsert (MOTIR-1579 — the Development surface renders it).
    expect(prRow).toMatchObject({ title: 'no key here' });
    expect(await deliveredItemIds(prRow.id)).toEqual([]);
  });

  it('an illegal transition logs a no-op instead of crashing (item unchanged)', async () => {
    // A fresh item still in `todo`: a merged PR targets `done`, but todo→done is
    // NOT a legal edge in the default workflow — the webhook logs a no-op, never
    // throws, and the item is left as-is.
    const { user, workspace } = await makeWorkspace('illegal@example.com');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Beta',
      identifier: 'BETA',
    });
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Still in todo' },
      { userId: user.id, workspaceId: workspace.id },
    );
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-2', accountLogin: 'moooon', accountType: 'User' },
      repos: [
        {
          providerRepoId: '888',
          owner: 'moooon',
          name: 'beta',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    await linkPr(
      {
        workItemId: item.id,
        projectId: project.id,
        owner: 'moooon',
        name: 'beta',
        number: 7,
        headRef: `feat/${item.identifier}-a-change`,
        baseRef: 'main',
        title: `Some change (${item.identifier})`,
      },
      { userId: user.id, workspaceId: workspace.id },
    );

    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: item.identifier,
        state: 'closed',
        merged: true,
        installationId: 'inst-2',
        repoId: 888,
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'illegal_transition' });
    expect(await statusOf(item.id)).toBe('todo'); // unchanged, no crash
  });

  // ── MOTIR-3674 — the parse is retired ─────────────────────────────────────
  it('a pull request whose branch AND title name a REAL, resolvable key links NOTHING', async () => {
    // The case that used to link, and the whole point of the card: `feat/ACME-1-a-change`
    // plus `Some change (ACME-1)` is exactly what `parseKeyCandidates` resolved.
    // With no explicit link there is nothing to resolve FROM, so the delivery
    // takes the shipped `no_work_item` outcome and the card does not move.
    const s = await makeScenario('parse-retired@example.com');

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    expect(opened).toMatchObject({ event: 'pull_request', outcome: 'no_work_item' });
    expect(await statusOf(s.item.id)).toBe('in_progress'); // untouched
    // The row is still mirrored — the pull request is a fact about the repository
    // whatever it delivers. Only the LINK is absent.
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(prRow).toMatchObject({
      headRef: `feat/${s.item.identifier}-a-change`,
      title: `Some change (${s.item.identifier})`,
    });
    expect(await deliveredItemIds(prRow.id)).toEqual([]);

    // And it stays absent on the merge, which is the consequence that matters:
    // a card is not closed by a pull request that merely MENTIONS it.
    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );
    expect(merged).toMatchObject({ outcome: 'no_work_item' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('GRANDFATHERS a row the retired parse linked — `linked_manually` is not the condition', async () => {
    // The 1026 production rows the parse wrote carry `linked_manually: false`.
    // Gating the resolve on that flag would orphan every one of them on its next
    // delivery. The condition is the STORED LINK, so the row keeps driving the
    // sync — and keeps its flag, which now records only HOW the link was made.
    //
    // ⚠️ THE STORED LINK IS THE DELIVERY ROW NOW (MOTIR-3721), and the
    // grandfathering is unchanged BECAUSE of that: `work_item_delivery`'s
    // migration carried all 1096 stored links into the table, parse-written rows
    // included, for exactly this reason — which is why MOTIR-3757 could drop the
    // column without orphaning one of them. The fixture writes the delivery row
    // and `linked_manually: false`, which is exactly the state such a row has.
    const s = await makeScenario('grandfathered@example.com');
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_PROVIDER_ID } });
    const row = await adminDb.githubPullRequest.create({
      data: {
        provider: 'github',
        repoId: repo.id,
        number: 7,
        state: 'open',
        merged: false,
        headRef: `feat/${s.item.identifier}-a-change`,
        baseRef: 'main',
        title: `Some change (${s.item.identifier})`,
        linkedManually: false,
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: repo.workspaceId,
        workItemId: s.item.id,
        githubPullRequestId: row.id,
        repoId: repo.id,
      },
    });

    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    const after = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(await deliveredItemIds(after.id)).toEqual([s.item.id]);
    expect(after.linkedManually).toBe(false);
  });

  it('a PR on an unknown installation is a no-op', async () => {
    const s = await makeScenario('unknown@example.com');
    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, installationId: 'inst-nope' }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'unknown_installation' });
  });

  it('a non-lifecycle PR action (synchronize) is ignored', async () => {
    const s = await makeScenario('sync@example.com');
    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'synchronize', identifier: s.item.identifier }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
  });
});

describe('githubWebhookService — cross-repo (two-PR) card completes on the LAST merge (MOTIR-1604)', () => {
  const REPO_B_PROVIDER_ID = '556';

  /** makeScenario, plus a SECOND connected repo in the same installation — the
   *  two-repo shape of a cross-repo contract card (a producer PR in one repo +
   *  a consumer PR in the other, BOTH linked to ONE work item). */
  async function makeTwoRepoScenario(email: string) {
    const { user, workspace } = await makeWorkspace(email);
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Acme',
      identifier: 'ACME',
    });
    const ctx = { userId: user.id, workspaceId: workspace.id };
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'A cross-repo change' },
      ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
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
        {
          providerRepoId: REPO_B_PROVIDER_ID,
          owner: 'moooon',
          name: 'acme-ai',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    return { user, workspace, project, item, ctx };
  }

  it('a merge does NOT complete the item while a sibling linked PR is still open; the LAST merge does', async () => {
    const s = await makeTwoRepoScenario('twopr@example.com');
    // Both pull requests are linked to the SAME item — one call each, which is
    // what a card carrying a repository set instructs (one `link_pull_request`
    // per repository, never one per card).
    await linkFor(s, { number: 7, repo: 'acme' });
    await linkFor(s, { number: 8, repo: 'acme-ai' });

    // Two OPEN PRs — one per repo — both linked to the SAME work item.
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, number: 7 }),
    );
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'opened',
        identifier: s.item.identifier,
        number: 8,
        repoId: Number(REPO_B_PROVIDER_ID),
      }),
    );
    expect(await statusOf(s.item.id)).toBe('implemented');

    // Merge the FIRST PR while its sibling (#8) is still open — the item MUST
    // stay at Implemented, not flip to Done (the MOTIR-1604 cardinality guard).
    //
    // ⚠️ The OUTCOME changed with MOTIR-3674 and the change is the design
    // working. Both pull requests are now LINKED, so each carries a
    // `work_item_delivery` row, and `deferred_incomplete_delivery_set` — the more
    // specific gate, evaluated first (`work-item-delivery-links.md` Q3) — answers
    // before `deferred_open_pr` gets the question. Previously the parse wrote the
    // scalar and no delivery row, so the card fell through to the open-PR count.
    // The guarded BEHAVIOUR is identical: the card does not complete.
    const firstMerge = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        number: 7,
        state: 'closed',
        merged: true,
      }),
    );
    expect(firstMerge).toMatchObject({
      event: 'pull_request',
      outcome: 'deferred_incomplete_delivery_set',
      workItemId: s.item.id,
    });
    expect(await statusOf(s.item.id)).toBe('implemented');

    // Merge the SECOND (now LAST open) PR — the item completes.
    const lastMerge = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        number: 8,
        state: 'closed',
        merged: true,
        repoId: Number(REPO_B_PROVIDER_ID),
      }),
    );
    expect(lastMerge).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('a single-PR card still completes on its one merge (no regression from the guard)', async () => {
    const s = await makeTwoRepoScenario('single@example.com');
    await linkFor(s, { number: 7, repo: 'acme' });
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, number: 7 }),
    );
    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        number: 7,
        state: 'closed',
        merged: true,
      }),
    );
    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });
});

describe('githubWebhookService — installation grant mirror', () => {
  it('installation deleted removes the installation (idempotent)', async () => {
    const { workspace } = await makeWorkspace('del@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-del', accountLogin: 'moooon', accountType: 'User' },
      repos: [
        { providerRepoId: '1', owner: 'moooon', name: 'r', defaultBranch: 'main', archived: false },
      ],
    });

    const first = await githubWebhookService.handleEvent('installation', {
      action: 'deleted',
      installation: { id: 'inst-del' },
    });
    expect(first).toMatchObject({ event: 'installation', outcome: 'removed' });
    // A direct-DB ASSERTION runs as the OWNER (MOTIR-2887). It expects `null`,
    // which is exactly the assertion a policy-filtered read satisfies for the
    // wrong reason if the table's arm ever goes away; `github_installation` has
    // one today, so this held.
    const gone = await adminDb.githubInstallation.findUnique({
      where: { installationId: 'inst-del' },
    });
    expect(gone).toBeNull();

    // Redelivery after the row is gone — still a clean no-crash.
    const second = await githubWebhookService.handleEvent('installation', {
      action: 'deleted',
      installation: { id: 'inst-del' },
    });
    expect(second).toMatchObject({ event: 'installation', outcome: 'removed' });
  });

  it('an installation event for an unbound installation is skipped', async () => {
    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-unbound' },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'skipped_unbound' });
  });

  it('installation_repositories reconciles the selected repos from the authoritative set', async () => {
    const { publicKey: _pub, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    void _pub;
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/installation/repositories')) {
          return new Response(
            JSON.stringify({
              repositories: [
                { id: 555, name: 'acme', default_branch: 'main', owner: { login: 'moooon' } },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { workspace } = await makeWorkspace('recon@example.com');
    // Seed with a DIFFERENT repo that the authoritative set no longer includes.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-recon',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '111',
          owner: 'moooon',
          name: 'stale',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-recon', account: { login: 'moooon', type: 'Organization' } },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'synced' });

    // A direct-DB ASSERTION runs as the OWNER (MOTIR-2887). Note the relation
    // filter: this query touches `github_repo` AND, through the join,
    // `github_installation` — both armed here, but a query is only as visible as
    // its least-visible table (`notes.html` #269).
    const repos = await adminDb.githubRepo.findMany({
      where: { installation: { installationId: 'inst-recon' } },
    });
    expect(repos.map((r) => r.repoId)).toEqual(['555']); // reconciled to the authoritative set
  });
});

describe('githubWebhookService — code-graph index enqueue (MOTIR-1500)', () => {
  /** Stub the token + repositories endpoints; the authoritative set is `repos`. */
  function stubGithub(repos: Array<{ id: number; name: string }>): void {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/installation/repositories')) {
          return new Response(
            JSON.stringify({
              repositories: repos.map((r) => ({
                id: r.id,
                name: r.name,
                default_branch: 'main',
                owner: { login: 'moooon' },
              })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  /** Seed the ledger row that MEANS "this repo has a code graph": a succeeded
   *  `system.code-graph-index` run carrying the repo's `output.repoRef`. */
  async function seedSucceededIndex(workspaceId: string, repoRef: string): Promise<void> {
    await adminDb.jobRun.create({
      data: {
        workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: `evt-${repoRef}`,
        lane: 'engine',
        attempt: 0,
        status: 'succeeded',
        output: { indexed: true, repoRef, projectsIndexed: 1 },
      },
    });
  }

  /** Persist `keep` (id 111), then reconcile against `keep` + `fresh` (id 222)
   *  and return the index jobs the reconcile enqueued. */
  async function reconcileAndCollectIndexJobs(
    workspaceId: string,
    seedIndexFor: string[],
  ): Promise<Record<string, unknown>[]> {
    stubGithub([
      { id: 111, name: 'keep' },
      { id: 222, name: 'fresh' },
    ]);
    const sendSpy = spyOnJobDispatch();

    await githubInstallationService.persistInstallation({
      workspaceId,
      installation: {
        installationId: 'inst-cg',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '111',
          owner: 'moooon',
          name: 'keep',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    for (const repoRef of seedIndexFor) await seedSucceededIndex(workspaceId, repoRef);
    // The bind above (persistInstallation directly) doesn't enqueue; clear anything.
    sendSpy.mockClear();

    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-cg', account: { login: 'moooon', type: 'Organization' } },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'synced' });

    return dispatchedEvents(sendSpy)
      .filter((e) => e.name === 'system.code-graph-index')
      .map((e) => e.data as Record<string, unknown>);
  }

  it('enqueues one code-graph-index job per UN-INDEXED repo and skips the already-indexed', async () => {
    // Authoritative set = the already-present `keep` (id 111), which HAS a graph,
    // + a freshly-added `fresh` (id 222), which does not. Only `fresh` enqueues.
    const { workspace } = await makeWorkspace('cg-enqueue@example.com');
    const jobs = await reconcileAndCollectIndexJobs(workspace.id, ['moooon/keep']);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      installationId: 'inst-cg',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'fresh',
      defaultBranch: 'main',
    });
  });

  it('a reconcile RECOVERS a long-present repo that never got a first index (MOTIR-1961)', async () => {
    // The defect's exact state: `keep` has a github_repo row and NO index run.
    // Under the old novelty gate it was skipped as "already present" and could
    // never be indexed by any path; now the same reconcile picks it up.
    const { workspace } = await makeWorkspace('cg-recover@example.com');
    const jobs = await reconcileAndCollectIndexJobs(workspace.id, []);

    expect(jobs.map((d) => d['repoName'])).toEqual(['keep', 'fresh']);
  });

  it('a reconcile that changes nothing and indexes nothing new is a no-op (no re-index storm)', async () => {
    const { workspace } = await makeWorkspace('cg-quiet@example.com');
    const jobs = await reconcileAndCollectIndexJobs(workspace.id, ['moooon/keep', 'moooon/fresh']);

    expect(jobs).toEqual([]);
  });
});

describe('githubWebhookService — push → code-graph refresh enqueue (MOTIR-893)', () => {
  /** A GitHub `push` delivery body. The makeScenario repo is id 555 / branch `main`. */
  function pushPayload(
    opts: {
      ref?: string;
      repoId?: number;
      installationId?: string;
      deleted?: boolean;
      after?: string | null;
    } = {},
  ) {
    return {
      ref: opts.ref ?? 'refs/heads/main',
      ...(opts.after === null ? {} : { after: opts.after ?? 'a'.repeat(40) }),
      ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
      repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
      installation: { id: opts.installationId ?? INSTALLATION_ID },
    };
  }

  // `vi.spyOn` returns the SAME mock (with its accumulated history) when the
  // method is already spied, and the file's afterEach doesn't restore mocks —
  // so restore here to keep each push test's call history isolated.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fresh, history-clean spy on the enqueue transport. */
  function spySend() {
    const spy = spyOnJobDispatch();
    spy.mockClear();
    return spy;
  }

  /** The spy's calls that enqueued the REFRESH event. */
  function refreshCalls(sendSpy: { mock: { calls: unknown[][] } }) {
    return dispatchedEvents(sendSpy).filter((e) => e.name === 'system.code-graph-refresh');
  }

  it('a default-branch push enqueues the incremental refresh job (async, not inline)', async () => {
    const { workspace } = await makeScenario('push-default@example.com');
    const sendSpy = spySend();

    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });

    const calls = refreshCalls(sendSpy);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({
      installationId: INSTALLATION_ID,
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
    });
  });

  it('a push to a NON-default branch is ignored — no refresh enqueued', async () => {
    await makeScenario('push-feature@example.com');
    const sendSpy = spySend();

    const res = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/heads/subtask/MOTIR-893-feature' }),
    );
    expect(res).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  it('a tag push and a branch deletion are ignored (not branch pushes)', async () => {
    await makeScenario('push-tag@example.com');
    const sendSpy = spySend();

    const tag = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/tags/v1.0.0' }),
    );
    expect(tag).toEqual({ event: 'push', outcome: 'ignored_ref' });

    const del = await githubWebhookService.handleEvent('push', pushPayload({ deleted: true }));
    expect(del).toEqual({ event: 'push', outcome: 'ignored_ref' });

    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  it('a push to a repo we do not track (or an unknown installation) is a clean no-op', async () => {
    await makeScenario('push-unknown@example.com');
    const sendSpy = spySend();

    const repo = await githubWebhookService.handleEvent('push', pushPayload({ repoId: 999 }));
    expect(repo).toEqual({ event: 'push', outcome: 'unknown_repo' });

    const inst = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ installationId: 'inst-nope' }),
    );
    expect(inst).toEqual({ event: 'push', outcome: 'unknown_installation' });

    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  // ── MOTIR-1766 — the STALENESS INPUT ──────────────────────────────────────
  //
  // "Stale" means the indexed commit is BEHIND the default-branch head. motir-ai
  // supplies the indexed commit; nothing supplied the head, so the only way to
  // answer "are we behind?" was a provider call per repo on every page render.
  // The head is already in this payload and was already being discarded.

  /** The stored repo row, read through the OWNER client (a direct-DB assertion). */
  async function storedRepo() {
    return adminDb.githubRepo.findFirstOrThrow({ where: { repoId: REPO_PROVIDER_ID } });
  }

  it('a default-branch push RECORDS the head sha + timestamp, and still enqueues', async () => {
    await makeScenario('push-head@example.com');
    const sendSpy = spySend();

    const before = await storedRepo();
    expect(before.lastPushSha).toBeNull();
    expect(before.lastPushedAt).toBeNull();

    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(refreshCalls(sendSpy)).toHaveLength(1);

    const after = await storedRepo();
    expect(after.lastPushSha).toBe('a'.repeat(40));
    expect(after.lastPushedAt).toBeInstanceOf(Date);
  });

  it('a REDELIVERED push is a no-op on the stored head — the timestamp does not drift', async () => {
    await makeScenario('push-head-redeliver@example.com');
    spySend();

    await githubWebhookService.handleEvent('push', pushPayload());
    const first = await storedRepo();

    // GitHub retries. The same push must not drag the timestamp forward, or it
    // stops meaning "when this head arrived".
    await githubWebhookService.handleEvent('push', pushPayload());
    const second = await storedRepo();

    expect(second.lastPushSha).toBe(first.lastPushSha);
    expect(second.lastPushedAt?.getTime()).toBe(first.lastPushedAt?.getTime());
  });

  it('a LATER push advances the head', async () => {
    await makeScenario('push-head-advance@example.com');
    spySend();

    await githubWebhookService.handleEvent('push', pushPayload());
    await githubWebhookService.handleEvent('push', pushPayload({ after: 'b'.repeat(40) }));

    expect((await storedRepo()).lastPushSha).toBe('b'.repeat(40));
  });

  it('a non-default branch, a tag, a deletion, an unknown repo and an unknown installation record NOTHING', async () => {
    await makeScenario('push-head-nothing@example.com');
    spySend();

    await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/heads/subtask/MOTIR-1766-feature', after: 'b'.repeat(40) }),
    );
    await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/tags/v1.0.0', after: 'c'.repeat(40) }),
    );
    await githubWebhookService.handleEvent(
      'push',
      pushPayload({ deleted: true, after: 'd'.repeat(40) }),
    );
    await githubWebhookService.handleEvent('push', pushPayload({ repoId: 999 }));
    await githubWebhookService.handleEvent('push', pushPayload({ installationId: 'inst-nope' }));

    const row = await storedRepo();
    expect(row.lastPushSha).toBeNull();
    expect(row.lastPushedAt).toBeNull();
  });

  it('a payload with no `after` records nothing — NULL means UNKNOWN, not a head', async () => {
    await makeScenario('push-head-no-after@example.com');
    spySend();

    // `parsePushEvent` normalizes a missing `after` to `headSha: null`. Writing it
    // would overwrite a known head with an unknown one.
    await githubWebhookService.handleEvent('push', pushPayload({ after: null }));

    expect((await storedRepo()).lastPushSha).toBeNull();
  });

  it('a head-write FAILURE is logged and never fails the delivery', async () => {
    await makeScenario('push-head-throws@example.com');
    spySend();
    vi.spyOn(githubRepoRepository, 'recordDefaultBranchHead').mockRejectedValue(
      new Error('db down'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The webhook's contract is a fast 2xx: a 500 here makes GitHub retry a
    // delivery no retry can fix, and a missed head is self-healing anyway.
    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('an enqueue transport failure never fails the ack (best-effort, fast 2xx)', async () => {
    await makeScenario('push-enqueue-down@example.com');
    spyOnJobDispatch().mockRejectedValue(new Error('queue down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(errorSpy).toHaveBeenCalled(); // dropped refresh is logged, not thrown

    errorSpy.mockRestore();
  });
});

describe('githubWebhookService — dispatch', () => {
  it('ignores an unhandled event type (a fast no-op ack)', async () => {
    const res = await githubWebhookService.handleEvent('ping', { zen: 'Keep it simple' });
    expect(res).toMatchObject({ event: 'ignored' });
  });
});
