import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { commentsService } from '@/lib/services/commentsService';
import type { GithubWebhookResult } from '@/lib/services/githubWebhookService';
import type { ChangeRequestSyncResult } from '@/lib/services/changeRequestStatusSync';
import { DeliveredItemsTransitionFailedError } from '@/lib/git/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';

// MOTIR-5587 — ONE CARD'S FAULT MUST NOT STRAND EVERY CARD AFTER IT.
//
// `motir-ai#487` merged delivering 36 cards. The sync moved 11 of them to Done in
// 14 seconds and left the other 25 at In Review, with every delivery row reading
// `merged` and nothing on any card to say so. The split was POSITIONAL — a prefix
// moved, a suffix did not — and no property of the cards separated the two groups.
//
// The filing card guessed at ONE transaction enclosing all 36 transitions. The code
// says otherwise: each card moves in its own transaction (`updateStatus` opens one
// per call). What produces a prefix is the LOOP: `classifyTransitionError` rethrows
// anything that is not a declared refusal, and a rethrow out of card k leaves the
// loop, so cards k+1…N are never attempted. The tenant had just measured the kind
// of fault that does it — `Transaction API error: Unable to start a transaction in
// the given time` (P2028) — and a starved pool that fails one start fails the next.
//
// So these tests inject exactly that fault on ONE card, in the middle, and assert
// on the whole set rather than on a sample (acceptance criterion 1 asks for that in
// so many words): a test that checks the first few cards passes against the defect.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-per-card-isolation';
const REPO_PROVIDER_ID = '9587';
const BRANCH = 'motir/auto-run-487';
const PR_NUMBER = 487;
/** The count that failed in production. */
const CARD_COUNT = 36;
/** Card 12 — the first card that did not move in production. */
const FAILING_INDEX = 11;

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
        name: 'motir-ai',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  await linkWorkspaceReposToProject({
    workspaceId: workspace.id,
    projectId: project.id,
    names: ['motir-ai'],
  });
  return { user, workspace, project, ctx };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function prPayload(opts: { action: string; state?: 'open' | 'closed'; merged?: boolean }) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: PR_NUMBER,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? '2026-09-15T19:13:40.000Z' : null,
      title: 'A sweep delivering many cards',
      head: { ref: BRANCH },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

const pr = (payload: ReturnType<typeof prPayload>) =>
  githubWebhookService.handleEvent('pull_request', payload);

const mergeDelivery = () => pr(prPayload({ action: 'closed', state: 'closed', merged: true }));

function asSync(result: GithubWebhookResult): ChangeRequestSyncResult {
  if (result.event !== 'pull_request') {
    throw new Error(`expected a pull_request result, got "${result.event}"`);
  }
  return result;
}

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function statusesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await adminDb.workItem.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, status: true },
  });
  return new Map(rows.map((r) => [r.id, r.status]));
}

async function revisionCount(workItemId: string): Promise<number> {
  return adminDb.workItemRevision.count({ where: { workItemId } });
}

async function commentsOn(workItemId: string) {
  return adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}

/** N cards, every one linked to the ONE pull request and sitting at In Review —
 *  the shape `motir-ai#487` had the moment before its merge. */
async function deliverManyCards(s: Scenario, count: number) {
  await pr(prPayload({ action: 'opened' }));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'bug', title: `planning bug ${i + 1}` },
      s.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'motir-ai',
        number: PR_NUMBER,
        headRef: BRANCH,
        baseRef: 'main',
        title: null,
      },
      s.ctx,
    );
    // The link resync may already have moved it; walk whatever rungs are left.
    if ((await statusOf(item.id)) === 'in_progress') {
      await workItemsService.updateStatus(item.id, 'implemented', s.ctx);
    }
    await workItemsService.updateStatus(item.id, 'in_review', s.ctx);
    ids.push(item.id);
  }
  return ids;
}

/** The fault production measured on this tenant, raised by ONE card's transition
 *  only — every other card goes through the real `updateStatus`. */
function failTransitionOf(failingId: string) {
  const real = workItemsService.updateStatus.bind(workItemsService);
  return vi.spyOn(workItemsService, 'updateStatus').mockImplementation(async (id, ...rest) => {
    if (id === failingId) {
      throw new Prisma.PrismaClientKnownRequestError(
        'Transaction API error: Unable to start a transaction in the given time.',
        { code: 'P2028', clientVersion: 'test' },
      );
    }
    return real(id, ...rest);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a merge delivering 36 cards moves EVERY one of them (MOTIR-5587 AC 1)', () => {
  it('closes all 36 — asserted over the full set, not a sample', async () => {
    const s = await makeScenario('thirty-six@example.com');
    const ids = await deliverManyCards(s, CARD_COUNT);

    const synced = asSync(await mergeDelivery());

    expect(synced.outcome).toBe('delivery_applied');
    expect(synced.deliveredItems).toHaveLength(CARD_COUNT);
    for (const d of synced.deliveredItems ?? []) {
      expect(d).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    }
    const statuses = await statusesOf(ids);
    expect([...statuses.values()].filter((st) => st !== 'done')).toEqual([]);
    expect(statuses.size).toBe(CARD_COUNT);
  }, 120_000);
});

describe('ONE card faulting part-way does not strand the cards after it (MOTIR-5587 AC 2)', () => {
  it('attempts every card, closes all the others, and names the one it could not move', async () => {
    const s = await makeScenario('fault@example.com');
    const ids = await deliverManyCards(s, CARD_COUNT);
    const failingId = ids[FAILING_INDEX]!;
    failTransitionOf(failingId);

    // The delivery still FAILS — deliberately. A delivery that faulted must not look
    // finished, or the open-delivery reconcile (MOTIR-5390) never replays it. What
    // changes is that it fails AFTER trying every card, and names what it missed.
    const err = await mergeDelivery().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeliveredItemsTransitionFailedError);
    const failure = err as DeliveredItemsTransitionFailedError;
    expect(failure.attempted).toBe(CARD_COUNT);
    expect(failure.failed.map((f) => f.workItemId)).toEqual([failingId]);
    expect(failure.message).toContain('1 of 36');

    // Every card BEFORE and AFTER the fault moved. The defect left 12…36 untouched.
    const statuses = await statusesOf(ids);
    const notDone = ids.filter((id) => statuses.get(id) !== 'done');
    expect(notDone).toEqual([failingId]);
    expect(statuses.get(failingId)).toBe('in_review');
  }, 120_000);

  it('says so ON the card it could not move — visible without reading the database', async () => {
    const s = await makeScenario('fault-note@example.com');
    const ids = await deliverManyCards(s, 3);
    const failingId = ids[1]!;
    failTransitionOf(failingId);

    await expect(mergeDelivery()).rejects.toBeInstanceOf(DeliveredItemsTransitionFailedError);

    const notes = await commentsOn(failingId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.bodyMd).toContain('#487 merged');
    expect(notes[0]!.bodyMd).toContain('could not be moved');
    // The fault's own words, so the reader is not sent to the logs for them.
    expect(notes[0]!.bodyMd).toContain('Unable to start a transaction');
    // The cards that DID move carry no note: a note is worth something only while
    // it is rare.
    for (const id of ids.filter((x) => x !== failingId)) {
      expect(await commentsOn(id)).toHaveLength(0);
    }
  });

  it('still attempts every card when the NOTE fails too — the usual case when the database is the fault', async () => {
    const s = await makeScenario('fault-note-fails@example.com');
    const ids = await deliverManyCards(s, 3);
    const failingId = ids[0]!;
    const real = workItemsService.updateStatus.bind(workItemsService);
    vi.spyOn(workItemsService, 'updateStatus').mockImplementation(async (id, ...rest) => {
      // Not even an `Error` — whatever escapes a transition is still reported.
      if (id === failingId) throw 'connection reset';
      return real(id, ...rest);
    });
    vi.spyOn(commentsService, 'addComment').mockRejectedValue(new Error('pool exhausted'));

    const err = await mergeDelivery().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeliveredItemsTransitionFailedError);
    expect((err as DeliveredItemsTransitionFailedError).failed).toEqual([
      { workItemId: failingId, message: 'connection reset' },
    ]);
    const statuses = await statusesOf(ids);
    expect(ids.filter((id) => statuses.get(id) !== 'done')).toEqual([failingId]);
  });

  it('leaves the delivery recognisable to the reconcile: merged, and no `merged_at` stamped', async () => {
    const s = await makeScenario('fault-reconcile@example.com');
    const ids = await deliverManyCards(s, 3);
    failTransitionOf(ids[0]!);

    await expect(mergeDelivery()).rejects.toBeInstanceOf(DeliveredItemsTransitionFailedError);

    // `listReconcileCandidates`' merged arm is exactly `merged: true, mergedAt: null`.
    // The post-commit capture that stamps `merged_at` runs only after a sync that
    // returned, so a sync that swallowed the fault would hide this card from the one
    // mechanism that retries it.
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number: PR_NUMBER },
    });
    expect(row).toMatchObject({ state: 'closed', merged: true, mergedAt: null });
  });
});

describe('re-running the sync after a truncated run finishes the job (MOTIR-5587 AC 3)', () => {
  it('moves the remaining card and changes nothing about the ones already closed', async () => {
    const s = await makeScenario('rerun@example.com');
    const ids = await deliverManyCards(s, CARD_COUNT);
    const failingId = ids[FAILING_INDEX]!;
    const spy = failTransitionOf(failingId);

    await expect(mergeDelivery()).rejects.toBeInstanceOf(DeliveredItemsTransitionFailedError);
    const closed = ids.filter((id) => id !== failingId);
    const revisionsBefore = new Map(
      await Promise.all(closed.map(async (id) => [id, await revisionCount(id)] as const)),
    );
    const notesBefore = (await commentsOn(failingId)).length;

    // The fault clears; the delivery is replayed — by GitHub's redeliver button or
    // by the reconcile, both of which reach this same arm.
    spy.mockRestore();
    const rerun = asSync(await mergeDelivery());

    expect(rerun.outcome).toBe('delivery_applied');
    const byId = new Map((rerun.deliveredItems ?? []).map((d) => [d.workItemId, d]));
    expect(byId.get(failingId)).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    for (const id of closed) expect(byId.get(id)).toMatchObject({ outcome: 'noop' });

    const statuses = await statusesOf(ids);
    expect([...statuses.values()].filter((st) => st !== 'done')).toEqual([]);
    // Nothing about an already-closed card changed: no new revision on any of them…
    for (const id of closed) expect(await revisionCount(id)).toBe(revisionsBefore.get(id));
    // …and the replay does not post the failure note a second time.
    expect(await commentsOn(failingId)).toHaveLength(notesBefore);
  }, 120_000);
});
