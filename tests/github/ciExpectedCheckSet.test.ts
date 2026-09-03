import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
} from '@/lib/services/changeRequestCiFeedback';
import { promoteDeliveredCardsOnGreen, promoteIfCiAlreadyGreen } from '@/lib/services/ciPromotion';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import type { NormalizedStatusEvent } from '@/lib/git/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-4199 — THE VERDICT READS THE RECORDED SET AS THE WHOLE SET.
//
// The observed instance: a commit with five jobs, all queued at 20:45:26Z. Three
// completed `success`; the other two were still running and had no row recorded
// at all. Motir's feedback comment read `✅ CI passing — all 3 checks succeeded
// … This work is verified`, and the card was promoted `implemented → in_review`
// with the repository's 3 000-test Vitest lane still executing. Nothing was red,
// so nothing looked wrong.
//
// Every derivation on the path is a fold over the rows RECORDED at the head sha
// — the comment's summary, the aggregate `ciState`, and both promotion edges —
// and none of them could tell a commit whose five checks have all reported from
// one whose first three have. GitHub delivers check runs one webhook at a time,
// so the recorded set being a PREFIX of the real set is the ordinary state of
// every pull request for its first minutes.
//
// ── WHY THESE TESTS DRIVE `applyCiStatusFeedback` DIRECTLY ──────────────────
// The fix asks the HOST which check runs a commit has, through the same
// provider-supplied context callback the consumer already takes its
// `buildChecksUrl` from. `githubWebhookService.handleEvent` supplies the real
// GitHub reader, which in this environment cannot mint a token and answers
// `null` — the "could not establish" arm, exercised on its own below. To drive
// the PARTIAL-SET case at all, a test has to supply the callback, and the
// consumer's own seam is where it is supplied. The promotion path underneath is
// the real one: `promoteDeliveredCardsOnGreen`, the real transitions, real
// Postgres.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-expected-set';
const REPO_PROVIDER_ID = '4199';
const SUITE_ID = '87626130152';
const HEAD_SHA = '4eae3f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The fixture's five jobs, in the order the observation recorded them. The
 *  first three completed before the last two were recorded at all. */
const THE_THREE = ['TypeScript build', 'Boot smoke (native-ESM interop)', 'Prettier'];
const THE_OTHER_TWO = ['Vitest', 'Indexer image / Build, assert, prove'];

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
  const installation = (await adminDb.githubInstallation.findFirst({
    where: { installationId: INSTALLATION_ID },
  }))!;
  const repo = (await adminDb.githubRepo.findFirst({
    where: { installationId: installation.id, repoId: REPO_PROVIDER_ID },
  }))!;
  return { user, workspace, project, ctx, installation, repo };
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

/** A card at `implemented` with its own linked pull request — the shape the
 *  fixture had when the verdict was written. */
async function cardWithPr(s: Scenario, title: string, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  const headRef = `subtask/${item.identifier}-work`;
  await linkPrByIdentifier({
    identifier: item.identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef,
    title: `A change (${headRef})`,
  });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

function event(name: string, conclusion: 'success' | 'failure' | 'pending'): NormalizedStatusEvent {
  return {
    providerRepoId: REPO_PROVIDER_ID,
    commitSha: HEAD_SHA,
    conclusion,
    context: name,
    prNumbers: [],
    headBranch: null,
    suiteId: SUITE_ID,
  };
}

/** What the HOST says the commit has. `undefined` supplies no callback at all —
 *  the GitLab shape, and the pre-MOTIR-4199 behaviour; `null` is the callback
 *  answering "could not establish". */
function reported(
  entries: [name: string, conclusion: 'success' | 'failure' | 'pending'][],
): ReportedCheckRun[] {
  return entries.map(([checkName, conclusion]) => ({
    checkName,
    checkSuiteId: SUITE_ID,
    conclusion,
  }));
}

/** Drive one CI delivery through the real consumer with a given host answer.
 *  Counts the host calls so the "what does it cost?" assertions can read them. */
function deliverer(s: Scenario, prNumber: number, hostAnswer: () => ReportedCheckRun[] | null) {
  const calls: string[] = [];
  const resolveContext = async (): Promise<CiFeedbackContextResolution> => ({
    kind: 'resolved',
    installation: s.installation,
    repo: s.repo,
    buildChecksUrl: (n: number) => `https://github.com/moooon/acme/pull/${n}/checks`,
    readReportedCheckSet: async (commitSha: string) => {
      calls.push(commitSha);
      return hostAnswer();
    },
  });
  return {
    calls,
    deliver: (name: string, conclusion: 'success' | 'failure' | 'pending') =>
      applyCiStatusFeedback({ ...event(name, conclusion), prNumbers: [prNumber] }, resolveContext),
  };
}

/** The same, with NO host callback — exactly what shipped before this card, and
 *  what a provider that supplies none (GitLab) still gets. */
function bareDeliverer(s: Scenario, prNumber: number) {
  const resolveContext = async (): Promise<CiFeedbackContextResolution> => ({
    kind: 'resolved',
    installation: s.installation,
    repo: s.repo,
    buildChecksUrl: (n: number) => `https://github.com/moooon/acme/pull/${n}/checks`,
  });
  return (name: string, conclusion: 'success' | 'failure' | 'pending') =>
    applyCiStatusFeedback({ ...event(name, conclusion), prNumbers: [prNumber] }, resolveContext);
}

/**
 * Put check rows at the head commit WITHOUT going through a delivery.
 *
 * ⚠️ THE ARRIVAL EDGE CANNOT BE SET UP BY DELIVERING (MOTIR-4199). Moving a card
 * to `implemented` through the service is exactly what FIRES edge 2 — that is
 * what the latch is — so a fixture that delivers a green set and then puts the
 * card back at `implemented` has already run the edge it is trying to test, and
 * has run it with the production reader rather than the injected one. Writing
 * the rows directly leaves the card where `cardWithPr` left it and makes the
 * explicit call the first and only time the edge fires.
 */
async function seedRows(
  prNumber: number,
  entries: [name: string, conclusion: 'success' | 'failure' | 'pending'][],
): Promise<void> {
  const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: prNumber } }))!;
  await adminDb.githubCheckRun.createMany({
    data: entries.map(([checkName, conclusion]) => ({
      pullRequestId: pr.id,
      commitSha: HEAD_SHA,
      checkName,
      checkSuiteId: SUITE_ID,
      conclusion,
    })),
  });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function latestCommentOn(workItemId: string): Promise<string> {
  const rows = await adminDb.comment.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.at(-1)!.bodyMd;
}

async function commentCountOn(workItemId: string): Promise<number> {
  return adminDb.comment.count({ where: { workItemId } });
}

async function checkRowsAtHead() {
  return adminDb.githubCheckRun.findMany({
    where: { commitSha: HEAD_SHA },
    orderBy: { checkName: 'asc' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a recorded set that is a PREFIX of the commit’s real check set', () => {
  it('writes the INTERIM comment and promotes nothing — the fixture, three of five', async () => {
    const s = await makeScenario('prefix-interim@example.com');
    const card = await cardWithPr(s, 'the card the verdict was about', 101);

    // The host knows the commit has five jobs from the moment the run starts.
    // Its answer tracks reality: the checks that have completed read `success`,
    // the rest read as still running — while OUR recorded set has only the rows
    // whose webhooks have been processed.
    let done = 0;
    const host = deliverer(s, 101, () =>
      reported([
        ...THE_THREE.map((n, i) => [n, i < done ? 'success' : 'pending'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]),
    );

    for (const name of THE_THREE) {
      done += 1;
      const result = await host.deliver(name, 'success');
      // The whole point: no promotion at any step of the prefix.
      expect(result.promoted).toBeUndefined();
    }

    const body = await latestCommentOn(card.id);
    expect(body).toContain('CI running');
    expect(body).toContain('3 of 5 checks complete');
    expect(body).toContain('No verdict yet');
    expect(body).not.toContain('This work is verified');

    expect(await statusOf(card.id)).toBe('implemented');

    // The two missing checks are now RECORDED, as pending rows — the fix writes
    // into the same table every derivation already reads, so nothing downstream
    // had to learn a new concept.
    const rows = await checkRowsAtHead();
    expect(rows).toHaveLength(5);
    expect(
      rows
        .filter((r) => r.conclusion === 'pending')
        .map((r) => r.checkName)
        .sort(),
    ).toEqual([...THE_OTHER_TWO].sort());
  });

  it('promotes once the missing rows ARRIVE and the set is terminal — one comment throughout', async () => {
    const s = await makeScenario('prefix-then-complete@example.com');
    const card = await cardWithPr(s, 'the card that finishes', 102);

    const partial = deliverer(s, 102, () =>
      reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]),
    );
    for (const name of THE_THREE) await partial.deliver(name, 'success');
    expect(await statusOf(card.id)).toBe('implemented');

    // The slow lanes report, in the order GitHub would deliver them.
    const whole = deliverer(s, 102, () =>
      reported([...THE_THREE, ...THE_OTHER_TWO].map((n) => [n, 'success'] as [string, 'success'])),
    );
    await whole.deliver(THE_OTHER_TWO[0]!, 'success');
    expect(await statusOf(card.id)).toBe('implemented');
    const last = await whole.deliver(THE_OTHER_TWO[1]!, 'success');

    expect(last.promoted).toEqual([card.id]);
    expect(await statusOf(card.id)).toBe('in_review');

    const body = await latestCommentOn(card.id);
    expect(body).toContain('CI passing');
    expect(body).toContain('all 5 checks succeeded');
    // ONE comment per (change request, head sha, card) — edited in place, never a
    // second one, which is MOTIR-2946's contract and is not weakened here.
    expect(await commentCountOn(card.id)).toBe(1);
  });

  it('a fourth success and a fifth FAILURE reads "1 of 5" and leaves the card at implemented', async () => {
    const s = await makeScenario('prefix-then-red@example.com');
    const card = await cardWithPr(s, 'the card whose late lane goes red', 103);

    const partial = deliverer(s, 103, () =>
      reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]),
    );
    for (const name of THE_THREE) await partial.deliver(name, 'success');

    const whole = deliverer(s, 103, () =>
      reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        [THE_OTHER_TWO[0]!, 'success'],
        [THE_OTHER_TWO[1]!, 'failure'],
      ]),
    );
    await whole.deliver(THE_OTHER_TWO[0]!, 'success');
    const red = await whole.deliver(THE_OTHER_TWO[1]!, 'failure');

    expect(red.outcome).toBe('failed');
    expect(red.promoted).toBeUndefined();
    const body = await latestCommentOn(card.id);
    expect(body).toContain('CI failed');
    expect(body).toContain('1 of 5 checks did not pass');
    expect(body).toContain(THE_OTHER_TWO[1]!);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('is the defect without the host answer — the control that makes the fixture a fix', async () => {
    // The SAME three deliveries with no host callback at all: this is what
    // shipped, and it is what a provider supplying none still gets. Kept as a
    // control so the assertions above cannot pass for some unrelated reason.
    const s = await makeScenario('prefix-control@example.com');
    const card = await cardWithPr(s, 'the pre-fix behaviour', 104);
    const deliver = bareDeliverer(s, 104);

    for (const name of THE_THREE) await deliver(name, 'success');

    expect(await latestCommentOn(card.id)).toContain('all 3 checks succeeded');
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

describe('BOTH promotion edges withhold on the same set — asserted separately', () => {
  /** Bring a card to the fixture's state: five recorded rows, three terminal and
   *  two pending, with nothing yet promoted. */
  async function atThreeOfFive(s: Scenario, number: number, title: string) {
    const card = await cardWithPr(s, title, number);
    const host = deliverer(s, number, () =>
      reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]),
    );
    for (const name of THE_THREE) await host.deliver(name, 'success');
    expect(await statusOf(card.id)).toBe('implemented');
    return card;
  }

  it('EDGE 1 — `promoteDeliveredCardsOnGreen` promotes nothing', async () => {
    const s = await makeScenario('edge1-withholds@example.com');
    const card = await atThreeOfFive(s, 105, 'edge one');

    const pr = (await adminDb.githubPullRequest.findFirst({ where: { number: 105 } }))!;
    const promoted = await promoteDeliveredCardsOnGreen({
      changeRequestId: pr.id,
      workspaceId: s.workspace.id,
      actorUserId: s.user.id,
    });

    expect(promoted).toEqual([]);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('EDGE 2 — `promoteIfCiAlreadyGreen` withholds on that same set', async () => {
    const s = await makeScenario('edge2-withholds@example.com');
    const card = await atThreeOfFive(s, 106, 'edge two');

    expect(await promoteIfCiAlreadyGreen(card.id, s.ctx)).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('EDGE 2 asks the host ITSELF when it arrives before any delivery has reconciled', async () => {
    // The arrival edge has no delivery behind it — it fires the moment a card
    // reaches `implemented`, which a run does right after `gh pr create`, when
    // the recorded set is at its most partial. Left reading only what is
    // recorded it would promote three-of-five for exactly the reason edge 1 no
    // longer does.
    const s = await makeScenario('edge2-asks@example.com');
    const card = await cardWithPr(s, 'nothing has reconciled yet', 107);

    // Three terminal rows and no pending one — the recorded set CLAIMS to be
    // whole, and nothing has told it otherwise.
    await seedRows(
      107,
      THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
    );

    const asked: string[] = [];
    const promoted = await promoteIfCiAlreadyGreen(card.id, s.ctx, async (args) => {
      asked.push(args.commitSha);
      return reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]);
    });

    expect(asked).toEqual([HEAD_SHA]);
    expect(promoted).toBe(false);
    expect(await statusOf(card.id)).toBe('implemented');
    expect(await checkRowsAtHead()).toHaveLength(5);
  });

  it('EDGE 2 promotes when the host confirms the set IS whole and green', async () => {
    const s = await makeScenario('edge2-confirms@example.com');
    const card = await cardWithPr(s, 'the host agrees', 108);

    await seedRows(
      108,
      [...THE_THREE, ...THE_OTHER_TWO].map((n) => [n, 'success'] as [string, 'success']),
    );

    const promoted = await promoteIfCiAlreadyGreen(card.id, s.ctx, async () =>
      reported([...THE_THREE, ...THE_OTHER_TWO].map((n) => [n, 'success'] as [string, 'success'])),
    );

    expect(promoted).toBe(true);
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

describe('what the round trip COSTS, and when it is not paid', () => {
  it('is NOT paid while a live PENDING row is recorded at the head sha', async () => {
    // The ordinary case: GitHub's `created` / `in_progress` deliveries arrive
    // before the slow lanes finish, so the recorded set never claims to be
    // whole, the comment is interim already and the promotion withholds already.
    // There is no claim to check and nothing to buy.
    const s = await makeScenario('cost-not-paid@example.com');
    const card = await cardWithPr(s, 'pending rows are already recorded', 109);

    const host = deliverer(s, 109, () => reported([['whatever', 'pending']]));
    await host.deliver(THE_OTHER_TWO[0]!, 'pending');
    await host.deliver(THE_THREE[0]!, 'success');

    expect(host.calls).toEqual([]);
    expect(await latestCommentOn(card.id)).toContain('1 of 2 checks complete');
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('is paid ONCE per delivery that would otherwise assert a verdict', async () => {
    const s = await makeScenario('cost-paid-once@example.com');
    await cardWithPr(s, 'thirty-four checks, three claims', 110);

    const host = deliverer(s, 110, () =>
      reported([
        ...THE_THREE.map((n) => [n, 'success'] as [string, 'success']),
        ...THE_OTHER_TWO.map((n) => [n, 'pending'] as [string, 'pending']),
      ]),
    );
    // The first delivery claims completeness (nothing recorded contradicts it)
    // and pays. From the second on, the reconcile's pending rows are there, so
    // no further call is made.
    for (const name of THE_THREE) await host.deliver(name, 'success');

    expect(host.calls).toEqual([HEAD_SHA]);
  });

  it('falls back to the recorded set when the host cannot be reached', async () => {
    // `null` is "no answer", not "no checks". A transient outage costs the
    // sharper verdict — it does not stall every card behind an unfillable row.
    const s = await makeScenario('cost-unreachable@example.com');
    const card = await cardWithPr(s, 'the host is down', 111);

    const host = deliverer(s, 111, () => null);
    for (const name of THE_THREE) await host.deliver(name, 'success');

    expect(host.calls).toHaveLength(3);
    expect(await latestCommentOn(card.id)).toContain('all 3 checks succeeded');
    expect(await statusOf(card.id)).toBe('in_review');
    expect(await checkRowsAtHead()).toHaveLength(3);
  });

  it('an EMPTY host answer is not an outage — it records nothing and changes nothing', async () => {
    const s = await makeScenario('cost-empty@example.com');
    const card = await cardWithPr(s, 'the host reports no checks', 112);

    const host = deliverer(s, 112, () => []);
    await host.deliver(THE_THREE[0]!, 'success');

    expect(host.calls).toEqual([HEAD_SHA]);
    expect(await checkRowsAtHead()).toHaveLength(1);
    expect(await statusOf(card.id)).toBe('in_review');
  });
});

describe('the reconcile only ever CREATES', () => {
  it('never overwrites a terminal row with a staler answer from the snapshot', async () => {
    // The snapshot is taken before the write, so a delivery about one of these
    // checks may land in between. The unique key is the arbiter: a row that
    // exists wins, whatever the snapshot believed about it.
    const s = await makeScenario('reconcile-creates@example.com');
    const card = await cardWithPr(s, 'a stale snapshot', 113);

    const bare = bareDeliverer(s, 113);
    await bare(THE_OTHER_TWO[0]!, 'failure');
    // A failure promotes nothing, so the card is already where it needs to be.
    expect(await statusOf(card.id)).toBe('implemented');

    // The host's snapshot still has that check as pending — an answer read a
    // moment before the failure landed.
    const stale = deliverer(s, 113, () =>
      reported([
        [THE_THREE[0]!, 'success'],
        [THE_OTHER_TWO[0]!, 'pending'],
      ]),
    );
    await stale.deliver(THE_THREE[0]!, 'success');

    const rows = await checkRowsAtHead();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.checkName === THE_OTHER_TWO[0])!.conclusion).toBe('failure');
    expect(await latestCommentOn(card.id)).toContain('CI failed');
    expect(await statusOf(card.id)).toBe('implemented');
  });

  it('records the host’s OWN conclusion, so a DROPPED delivery is self-healing', async () => {
    // Writing `pending` for everything the recorded set lacked would be the
    // conservative-looking choice and would hold a card at Implemented for ever
    // behind a row nothing will refresh. The two transports describe the same
    // checks, so a run the host reports as completed is recorded as completed.
    const s = await makeScenario('reconcile-heals@example.com');
    const card = await cardWithPr(s, 'a delivery was dropped', 114);

    const host = deliverer(s, 114, () =>
      reported([...THE_THREE, ...THE_OTHER_TWO].map((n) => [n, 'success'] as [string, 'success'])),
    );
    // Only ONE of five deliveries ever arrives; the host says all five are green.
    const result = await host.deliver(THE_THREE[0]!, 'success');

    expect(result.promoted).toEqual([card.id]);
    expect(await latestCommentOn(card.id)).toContain('all 5 checks succeeded');
    expect(await statusOf(card.id)).toBe('in_review');
  });
});
