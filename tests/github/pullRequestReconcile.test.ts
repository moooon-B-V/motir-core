import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { mintInstallationToken } from '@/lib/github/appAuth';
import {
  PULL_REQUEST_RECONCILE_QUIET_MINUTES,
  pullRequestReconcileService,
} from '@/lib/services/pullRequestReconcileService';
import { pullRequestReconcile } from '@/lib/jobs/definitions/pullRequestReconcile';
import { jobDefinitions } from '@/lib/jobs/registry';
import { JobTestEngine } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE OPEN-DELIVERY RECONCILE (MOTIR-5390) over real Postgres, driven through the
// real `pull_request` webhook seam.
//
// The defect: a merge whose `pull_request` delivery failed or never arrived left
// the mirror row `open` and the card unclosed for ever — GitHub does not redeliver
// a failed App delivery and nothing re-read the host. Every case below asserts the
// card's STATUS and the reconcile's SUMMARY, because a reconcile that reports a
// replay while the card stays put is the same silent failure one level up.
//
// Stubbed, both ABOVE the code under test (the `historical-pr-backfill` precedent):
// `fetch` (the GitHub REST read) and `mintInstallationToken` (a real mint needs an
// App private key). Everything from the service down is real.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-reconcile';
const CORE_REPO_ID = '9301';
const AI_REPO_ID = '9302';
const MERGED_AT = '2026-09-13T19:58:55.000Z';

/** Past the quiet threshold, so every row written "now" is a candidate. */
const LATER = () => new Date(Date.now() + (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000);

type HostPr = {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
};

/** What GitHub currently says, per repo name + number. */
let host: Map<string, HostPr | { status: number }>;
let fetchMock: ReturnType<typeof vi.fn>;

function hostPayload(pr: HostPr) {
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged ? MERGED_AT : null,
    draft: false,
    title: 'Some change',
    head: { ref: pr.headRef },
    base: { ref: pr.baseRef },
    user: { id: 4242 },
  };
}

function installFetch() {
  fetchMock = vi.fn(async (url: string) => {
    const files = /\/repos\/moooon\/([^/]+)\/pulls\/(\d+)\/files/.exec(url);
    if (files)
      return new Response(JSON.stringify([{ filename: 'lib/changed.ts' }]), { status: 200 });
    const one = /\/repos\/moooon\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (!one) return new Response('not stubbed', { status: 500 });
    const entry = host.get(`${one[1]}#${one[2]}`);
    if (!entry) return new Response('{}', { status: 404 });
    if ('status' in entry) return new Response('{}', { status: entry.status });
    return new Response(JSON.stringify(hostPayload(entry)), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

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
        providerRepoId: CORE_REPO_ID,
        owner: 'moooon',
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
      {
        providerRepoId: AI_REPO_ID,
        owner: 'moooon',
        name: 'motir-ai',
        defaultBranch: 'trunk',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

type Member = { repo: 'motir-core' | 'motir-ai'; number: number; baseRef: string };
const CORE: Member = { repo: 'motir-core', number: 101, baseRef: 'main' };
const AI: Member = { repo: 'motir-ai', number: 202, baseRef: 'trunk' };

const providerIdOf = (m: Member) => (m.repo === 'motir-core' ? CORE_REPO_ID : AI_REPO_ID);

function deliveryPayload(m: Member, headRef: string, opts: { action: string; merged?: boolean }) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID },
    repository: { id: Number(providerIdOf(m)) },
    pull_request: hostPayload({
      number: m.number,
      state: opts.merged ? 'closed' : 'open',
      merged: opts.merged ?? false,
      headRef,
      baseRef: m.baseRef,
    }),
  };
}

/** A card at `implemented` delivered by `members`, each opened and linked. */
async function linkedCard(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  members: Member[],
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const m of members) {
    const headRef = `subtask/${item.identifier}-${m.number}`;
    await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(m, headRef, { action: 'opened' }),
    );
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: m.repo,
        number: m.number,
        headRef,
        baseRef: m.baseRef,
        title: null,
      },
      s.ctx,
    );
  }
  if ((await statusOf(item.id)) !== 'implemented') {
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
  }
  return item;
}

/** The host now reports `m` MERGED into `baseRef` (its own base unless overridden). */
function hostMerged(item: { identifier: string }, m: Member, baseRef = m.baseRef) {
  host.set(`${m.repo}#${m.number}`, {
    number: m.number,
    state: 'closed',
    merged: true,
    headRef: `subtask/${item.identifier}-${m.number}`,
    baseRef,
  });
}

function hostOpen(item: { identifier: string }, m: Member) {
  host.set(`${m.repo}#${m.number}`, {
    number: m.number,
    state: 'open',
    merged: false,
    headRef: `subtask/${item.identifier}-${m.number}`,
    baseRef: m.baseRef,
  });
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function prRow(m: Member) {
  return adminDb.githubPullRequest.findFirstOrThrow({
    where: { number: m.number, repo: { name: m.repo } },
  });
}

/** Revisions that moved the card INTO `done` — the transition history, counted. */
async function doneTransitions(workItemId: string): Promise<number> {
  const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId } });
  return revisions.filter((r) => {
    const status = (r.diff as Record<string, unknown> | null)?.['status'] as
      | { to?: unknown }
      | undefined;
    return status?.to === 'done';
  }).length;
}

/** Hosts reads made for pull requests (excluding the merged-files capture). */
const hostReads = () =>
  fetchMock.mock.calls.filter(([url]) => /\/pulls\/\d+$/.test(String(url))).length;

beforeEach(async () => {
  await truncateAuthTables();
  host = new Map();
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(mintInstallationToken).mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a merge whose delivery was LOST is completed by the reconcile', () => {
  it('a merge delivery that FAILED leaves the card open — and the reconcile completes it', async () => {
    const s = await makeScenario('reconcile-failed@example.com');
    const card = await linkedCard(s, 'lost merge', [CORE]);

    // The merge delivery fails inside the sync's resolve transaction — the shape
    // of the 2026-09-13 incident (a transaction that could not start in time).
    vi.spyOn(githubPullRequestRepository, 'upsert').mockRejectedValueOnce(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    );
    await expect(
      githubWebhookService.handleEvent(
        'pull_request',
        deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
      ),
    ).rejects.toThrow(/Unable to start a transaction/);

    // The reproduction: the host has merged, Motir still says open, and nothing
    // will ever say otherwise on its own.
    expect((await prRow(CORE)).state).toBe('open');
    expect(await statusOf(card.id)).toBe('implemented');

    hostMerged(card, CORE);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, transitioned: 1, failed: 0 });
    expect(await statusOf(card.id)).toBe('done');
    const row = await prRow(CORE);
    expect(row).toMatchObject({ state: 'closed', merged: true });
    // The merged-path capture ran too, so the replayed row is indistinguishable
    // from one a real delivery wrote.
    expect(row.mergedAt?.toISOString()).toBe(MERGED_AT);
    expect(row.changedPaths).toEqual(['lib/changed.ts']);
  });

  it('a merge delivery that died AFTER writing the row — at the transition — is completed too', async () => {
    const s = await makeScenario('reconcile-halfway@example.com');
    const card = await linkedCard(s, 'half-way', [CORE]);

    // The sync commits the row upsert, then fails moving the card: the row reads
    // merged, the card has not moved, and the capture that stamps `merged_at`
    // never ran.
    vi.spyOn(workItemsService, 'updateStatus').mockRejectedValueOnce(
      new Error('Transaction API error: Unable to start a transaction in the given time.'),
    );
    await expect(
      githubWebhookService.handleEvent(
        'pull_request',
        deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
      ),
    ).rejects.toThrow(/Unable to start a transaction/);
    vi.restoreAllMocks();
    expect(await prRow(CORE)).toMatchObject({ state: 'closed', merged: true, mergedAt: null });
    expect(await statusOf(card.id)).toBe('implemented');

    hostMerged(card, CORE);
    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
    expect((await prRow(CORE)).mergedAt?.toISOString()).toBe(MERGED_AT);

    // …and, its capture now stamped, the row is not a candidate again.
    const again = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(again.examined).toBe(0);
  });

  it('a merged row with no `merged_at` OLDER than the lookback is not a candidate', async () => {
    const s = await makeScenario('reconcile-lookback@example.com');
    const card = await linkedCard(s, 'ancient', [CORE]);
    await adminDb.githubPullRequest.updateMany({
      data: {
        state: 'closed',
        merged: true,
        mergedAt: null,
        updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000),
      },
    });
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary.examined).toBe(0);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('a merge delivery that NEVER ARRIVED is completed the same way', async () => {
    const s = await makeScenario('reconcile-missing@example.com');
    const card = await linkedCard(s, 'never delivered', [CORE]);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
  });

  it('runs as the scheduled `system.pull-request-reconcile` job', async () => {
    expect(jobDefinitions).toContain(pullRequestReconcile);
    const s = await makeScenario('reconcile-job@example.com');
    const card = await linkedCard(s, 'via the job', [CORE]);
    hostMerged(card, CORE);
    // The job reads the real clock, so age the row past the threshold instead.
    await adminDb.githubPullRequest.updateMany({
      data: {
        updatedAt: new Date(Date.now() - (PULL_REQUEST_RECONCILE_QUIET_MINUTES + 1) * 60_000),
      },
    });

    const { result } = await new JobTestEngine({ function: pullRequestReconcile }).execute();

    expect(result).toMatchObject({ replayed: 1, transitioned: 1 });
    expect(await statusOf(card.id)).toBe('done');
  });
});

describe('the reconcile goes through the SAME gates a delivery does', () => {
  it('the delivery-set gate still holds a card whose sibling pull request is truly open on the host', async () => {
    const s = await makeScenario('reconcile-set@example.com');
    const card = await linkedCard(s, 'two repositories', [CORE, AI]);
    hostMerged(card, CORE);
    hostOpen(card, AI);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 2, replayed: 1, transitioned: 0, stillOpen: 1 });
    expect(await statusOf(card.id)).toBe('implemented');
    expect((await prRow(CORE)).merged).toBe(true);
    expect((await prRow(AI)).state).toBe('open');
  });

  it('the base-branch gate still refuses a merge into a non-default base', async () => {
    const s = await makeScenario('reconcile-base@example.com');
    const card = await linkedCard(s, 'stacked', [CORE]);
    hostMerged(card, CORE, 'subtask/some-dead-branch');

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ replayed: 1, transitioned: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

describe('a late real delivery and the reconcile converge on ONE transition', () => {
  it('reconcile first, then the real (late) delivery: one move to done', async () => {
    const s = await makeScenario('reconcile-late@example.com');
    const card = await linkedCard(s, 'late delivery', [CORE]);
    hostMerged(card, CORE);

    await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    const late = await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
    );

    expect(late).toMatchObject({ outcome: 'noop' });
    expect(await statusOf(card.id)).toBe('done');
    expect(await doneTransitions(card.id)).toBe(1);
  });

  it('real delivery first, then the reconcile: the row is no longer a candidate', async () => {
    const s = await makeScenario('reconcile-first@example.com');
    const card = await linkedCard(s, 'delivered', [CORE]);
    await githubWebhookService.handleEvent(
      'pull_request',
      deliveryPayload(CORE, `subtask/${card.identifier}-101`, { action: 'closed', merged: true }),
    );
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 0, replayed: 0 });
    expect(hostReads()).toBe(0);
    expect(await doneTransitions(card.id)).toBe(1);
  });
});

describe('the host calls are BOUNDED', () => {
  it('a row delivering only a FINISHED card is never fetched', async () => {
    const s = await makeScenario('reconcile-terminal@example.com');
    const card = await linkedCard(s, 'closed by hand', [CORE]);
    await workItemsService.updateStatus(card.id, 'in_review', s.ctx);
    // ⚠️ A SYSTEM write, since MOTIR-5526 (ADR `approval-gates.md` §6d AMENDMENT,
    // rule 2b): with its pull request still open, a HAND move to Done is refused —
    // the merge is Done's one writer. This fixture only needs a finished card, so
    // it reaches Done the way the importer or the cascade would.
    await withWorkspaceContext(s.ctx, (tx) =>
      workItemsService.applyStatusTransition(card.id, 'done', s.ctx, tx, { system: true }),
    );
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ examined: 1, skippedNoLiveCard: 1, replayed: 0 });
    expect(hostReads()).toBe(0);
  });

  it('a row delivering only an ARCHIVED card is never fetched', async () => {
    const s = await makeScenario('reconcile-archived@example.com');
    const card = await linkedCard(s, 'archived', [CORE]);
    await workItemsService.archiveWorkItem(card.id, s.ctx);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ skippedNoLiveCard: 1 });
    expect(hostReads()).toBe(0);
  });

  it('a row heard from inside the quiet threshold is not a candidate', async () => {
    const s = await makeScenario('reconcile-quiet@example.com');
    const card = await linkedCard(s, 'recent', [CORE]);
    hostMerged(card, CORE);

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: new Date() });

    expect(summary.examined).toBe(0);
    expect(hostReads()).toBe(0);
  });

  it('takes at most `batchSize` rows per pass, oldest first', async () => {
    const s = await makeScenario('reconcile-batch@example.com');
    const card = await linkedCard(s, 'two rows', [CORE, AI]);
    hostOpen(card, CORE);
    hostOpen(card, AI);
    await adminDb.githubPullRequest.updateMany({
      where: { number: AI.number },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({
      now: LATER(),
      batchSize: 1,
    });

    expect(summary).toMatchObject({ examined: 1, stillOpen: 1 });
    // Only the single-PR reads — the `opened` deliveries above also capture paths.
    const reads = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => /\/pulls\/\d+$/.test(url));
    expect(reads).toEqual([expect.stringMatching(/motir-ai\/pulls\/202$/)]);
  });

  it('a row still open on the host is stamped as heard-from, and nothing moves', async () => {
    const s = await makeScenario('reconcile-open@example.com');
    const card = await linkedCard(s, 'still open', [CORE]);
    hostOpen(card, CORE);
    const old = new Date(Date.now() - 60 * 60_000);
    await adminDb.githubPullRequest.updateMany({ data: { updatedAt: old } });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, replayed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
    expect((await prRow(CORE)).updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });
});

describe('a per-row failure is COUNTED, never thrown', () => {
  it('a pull request the host no longer has is reported as gone and moves nothing', async () => {
    const s = await makeScenario('reconcile-gone@example.com');
    const card = await linkedCard(s, 'gone', [CORE]);
    host.set('motir-core#101', { status: 404 });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ gone: 1, replayed: 0, failed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('an unreadable pull request and a failed mint are each counted, and the pass completes', async () => {
    const s = await makeScenario('reconcile-fail@example.com');
    const card = await linkedCard(s, 'unreadable', [CORE, AI]);
    host.set('motir-core#101', { status: 401 });
    hostMerged(card, AI);

    const first = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(first).toMatchObject({ examined: 2, failed: 1, replayed: 1 });

    vi.mocked(mintInstallationToken).mockRejectedValueOnce(new Error('no private key'));
    const second = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });
    expect(second).toMatchObject({ examined: 1, failed: 1, replayed: 0 });
    expect(await statusOf(card.id)).toBe('implemented');
  });
});

// ── MOTIR-5671: the sweep also repairs a card whose GATES are wrong ─────────────
describe('a card whose question went missing is repaired by the sweep', () => {
  it('a still-open row whose card is green and gateless gets its gate back', async () => {
    // A LOST EVENT costs a card its gate exactly as it costs it a merge: every
    // raise in the product hangs off a delivery, so a check-suite delivery that
    // never arrived leaves a green card with no question on it and nothing else
    // ever asks again. That is this sweep's own justification, applied to the
    // other thing a delivery carries — and it is independent of MOTIR-5670's
    // premise, which the measurement there falsified.
    const s = await makeScenario('reconcile-gate@example.com');
    const card = await linkedCard(s, 'green and gateless', [CORE]);
    hostOpen(card, CORE);

    // The green verdict arrived and its gate did not: the row is green, the card
    // is in review, and no gate exists. Written directly because the point is a
    // state the product cannot reach through a door — that is what makes it a
    // repair rather than a raise.
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(CORE)).id,
        commitSha: 'sha-lost',
        checkName: 'ci / vitest',
        conclusion: 'success',
      },
    });
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_review' } });
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, replayed: 0, gatesRaised: 1 });
    const [gate] = await adminDb.approvalGate.findMany({ where: { workItemId: card.id } });
    expect(gate).toMatchObject({ kind: 'pull_request_approval', state: 'awaiting' });
  });

  it('writes NOTHING for a card whose gates are already right', async () => {
    // `reconcileGatesFor` only raises what is missing and never supersedes, so a
    // sweep over a correct card is a no-op — which is what makes running it every
    // thirty minutes safe.
    const s = await makeScenario('reconcile-gate-noop@example.com');
    const card = await linkedCard(s, 'already right', [CORE]);
    hostOpen(card, CORE);
    await adminDb.githubPullRequest.updateMany({
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });

    const summary = await pullRequestReconcileService.reconcileOpenDeliveries({ now: LATER() });

    expect(summary).toMatchObject({ stillOpen: 1, gatesRaised: 0 });
    expect(await adminDb.approvalGate.count({ where: { workItemId: card.id } })).toBe(0);
  });
});
