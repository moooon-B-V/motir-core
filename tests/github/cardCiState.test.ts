import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { recomputeWorkItemCiState } from '@/lib/services/deliveryVerdict';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-5470 — `WorkItem.ciState` IS THE CARD'S VERDICT, folded over its whole
// delivery set.
//
// The column existed before this card and could not drive a badge or a filter,
// in four separate ways. Each `describe` below is one of them, named by number,
// because the value of this suite is that a later reader can tell which defect a
// red assertion is about:
//
//   1. NO `running`. A pending check wrote nothing, so a card whose fix was
//      already building kept reading `failing`.
//   2. THE LAST PULL REQUEST WON. The terminal arm stamped THIS pull request's
//      verdict onto each delivered card, so a card with two read whichever
//      reported last.
//   3. SESSION-BRANCH CARDS NEVER GOT ONE. The write looped over the LINKED
//      cards, which is empty on the session arm, so such a card stayed `null`.
//   4. LINKING OR UNLINKING NEVER RECOMPUTED IT.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-card-ci';
const REPO_PROVIDER_ID = '981';
/** A SECOND connected repository, so a card can be delivered by two pull
 *  requests in two repositories — the shape defect 2 is about. */
const OTHER_REPO_PROVIDER_ID = '982';

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
      {
        providerRepoId: OTHER_REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme-api',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

async function openPrIn(repoProviderId: string, headBranch: string, number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repoProviderId) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headBranch})`,
      head: { ref: headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A check event in a NAMED repository, so the two-repository cases can report
 *  independently. `conclusion: null` + `status: 'in_progress'` is the PENDING
 *  arm — the one defect 1 is about. */
function ci(opts: {
  repoProviderId?: string;
  conclusion: string | null;
  status?: string;
  headSha: string;
  prNumbers: number[];
  name?: string;
}) {
  return githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(opts.repoProviderId ?? REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name ?? 'build',
      check_suite: { head_branch: null },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });
}

async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}

async function makeCard(s: Awaited<ReturnType<typeof makeScenario>>, title: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  return item;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('defect 1 — the column carries `running` (MOTIR-5470)', () => {
  it('a pending check at a NEW head turns a failing card RUNNING, with nobody opening it', async () => {
    // The acceptance criterion in prose: "pushing a fix (a new pending check at a
    // new commit) turns Checks failing into Checks running". Under MOTIR-894's
    // terminal-only contract the pending arm wrote nothing at all, so this card
    // read `failing` for the whole time its fix was building — which is exactly
    // the window in which somebody scanning for red cards would go and fix a card
    // somebody was already fixing.
    const s = await makeScenario('running@example.com');
    const item = await makeCard(s, 'A change');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 11,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-work`, 11);

    await ci({ conclusion: 'failure', headSha: 'sha-red', prNumbers: [11] });
    expect(await ciStateOf(item.id)).toBe('failing');

    // The push: a pending check at a NEW commit.
    await ci({ conclusion: null, status: 'in_progress', headSha: 'sha-fix', prNumbers: [11] });
    expect(await ciStateOf(item.id)).toBe('running');

    // …and it settles green when that commit's check lands.
    await ci({ conclusion: 'success', headSha: 'sha-fix', prNumbers: [11] });
    expect(await ciStateOf(item.id)).toBe('passing');
  });
});

describe('defect 2 — the fold, not the last writer (MOTIR-5470)', () => {
  it('a card delivered by a failing and a passing pull request reads FAILING, in either arrival order', async () => {
    // This is the acceptance criterion "a card delivered by two pull requests,
    // one failing and one passing, shows Checks failing" — and the assertion that
    // arrival ORDER cannot change it, which is the defect itself. N = 1 passes
    // even with the last-writer-wins bug, so this case needs N = 2.
    const s = await makeScenario('fold@example.com');
    const item = await makeCard(s, 'A change across two repositories');

    for (const [name, number, repoProviderId] of [
      ['acme', 21, REPO_PROVIDER_ID],
      ['acme-api', 22, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
    }

    // RED first, then GREEN — the order in which the old stamp produced `passing`.
    await ci({ conclusion: 'failure', headSha: 'sha-a', prNumbers: [21] });
    expect(await ciStateOf(item.id)).toBe('failing');
    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'success',
      headSha: 'sha-b',
      prNumbers: [22],
    });
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('and reads PASSING only once EVERY delivering pull request is green', async () => {
    const s = await makeScenario('fold-green@example.com');
    const item = await makeCard(s, 'A change across two repositories');

    for (const [name, number, repoProviderId] of [
      ['acme', 31, REPO_PROVIDER_ID],
      ['acme-api', 32, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
    }

    await ci({ conclusion: 'success', headSha: 'sha-a', prNumbers: [31] });
    // One green out of two is NOT a green card — the second has not reported, so
    // the card is still waiting on a verdict.
    expect(await ciStateOf(item.id)).toBe('running');

    await ci({
      repoProviderId: OTHER_REPO_PROVIDER_ID,
      conclusion: 'success',
      headSha: 'sha-b',
      prNumbers: [32],
    });
    expect(await ciStateOf(item.id)).toBe('passing');
  });
});

describe('defect 3 — a session-branch card gets a verdict (MOTIR-5470)', () => {
  it('a card delivered by a run session branch, linked to nothing, reads its build', async () => {
    // `motir auto` integrates a whole run onto one session branch and opens ONE
    // pull request for it, and that branch deliberately carries no card key — so
    // the pull request links nothing and the old write, which looped over the
    // LINKED cards, reached none of them. Such a card stayed `null` for ever,
    // however red its build.
    const s = await makeScenario('session@example.com');
    const one = await makeCard(s, 'First card of the run');
    const two = await makeCard(s, 'Second card of the run');

    const sessionBranch = 'motir/auto-run-5470';
    // Written directly: `sessionBranch` is dispatch bookkeeping set by the claim
    // (`applyStatusTransition`'s `opts.sessionBranch`), and standing up a whole
    // scope claim would be setup about a different card. The assertion below is
    // about what is STORED, so the setup writes what a claim would have.
    await adminDb.workItem.updateMany({
      where: { id: { in: [one.id, two.id] } },
      data: { sessionBranch },
    });
    await openPrIn(REPO_PROVIDER_ID, sessionBranch, 41);

    await ci({ conclusion: 'failure', headSha: 'sha-session', prNumbers: [41] });
    // BOTH cards the run delivered, not one and not none.
    expect(await ciStateOf(one.id)).toBe('failing');
    expect(await ciStateOf(two.id)).toBe('failing');

    await ci({ conclusion: 'success', headSha: 'sha-session-2', prNumbers: [41] });
    expect(await ciStateOf(one.id)).toBe('passing');
    expect(await ciStateOf(two.id)).toBe('passing');
  });
});

describe('defect 4 — linking and unlinking recompute (MOTIR-5470)', () => {
  it('linking a pull request whose checks have ALREADY finished red turns the card red', async () => {
    // The case with NO EVENT COMING: the pull request's checks are done, so no
    // further check event will ever fire for it. If the link does not recompute,
    // nothing ever will.
    //
    // ⚠️ The pull request has to be linked to SOMETHING for its checks to be
    // recorded at all — `resolveChangeRequestWorkItemSet` returns `no_work_item`
    // and the feedback path exits before it writes a row. So the fixture is a
    // pull request that already delivers one card and goes red, and a SECOND card
    // linked to it afterwards: the second card is the one with no event coming.
    const s = await makeScenario('link@example.com');
    const first = await makeCard(s, 'The card the pull request already delivered');
    const second = await makeCard(s, 'The card linked afterwards');

    await linkPrByIdentifier({
      identifier: first.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 51,
      headRef: 'feat/shared-work',
      title: 'A change (feat/shared-work)',
    });
    await openPrIn(REPO_PROVIDER_ID, 'feat/shared-work', 51);
    await ci({ conclusion: 'failure', headSha: 'sha-done', prNumbers: [51] });
    expect(await ciStateOf(first.id)).toBe('failing');
    expect(await ciStateOf(second.id)).toBeNull();

    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 51 } });
    await githubPullRequestService.linkPullRequest(second.id, pr.id, s.ctx);
    // No check event fired between those two lines. The link itself is what told
    // the card, which is the whole of defect 4.
    expect(await ciStateOf(second.id)).toBe('failing');
  });

  it('unlinking that pull request takes the red back off the card', async () => {
    // The direction that strands a card visibly: retracting a mis-linked RED pull
    // request used to leave the card reading `failing` with nothing red left on
    // it, and the event that would have corrected it is the one that just stopped
    // delivering this card.
    const s = await makeScenario('unlink@example.com');
    const item = await makeCard(s, 'A change');

    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 61,
      headRef: 'feat/mislinked-work',
      title: 'A change (feat/mislinked-work)',
    });
    await openPrIn(REPO_PROVIDER_ID, 'feat/mislinked-work', 61);
    await ci({ conclusion: 'failure', headSha: 'sha-done', prNumbers: [61] });
    expect(await ciStateOf(item.id)).toBe('failing');

    const pr = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 61 } });
    await githubPullRequestService.unlinkPullRequest(item.id, pr.id, s.ctx);
    // No deliveries left ⇒ no checks ⇒ `null`, which is not a fourth verdict but
    // the absence of one.
    expect(await ciStateOf(item.id)).toBeNull();
  });
});

describe('a just-linked pull request with no check rows (MOTIR-5470)', () => {
  it('holds a passing card at RUNNING when its repository has reported checks before', async () => {
    // The acceptance criterion the two mappers exist for. A pull request opened
    // seconds ago has no rows, and reading that silence as green would announce
    // almost every card reviewable the instant its pull request opened. The
    // question is asked of the REPOSITORY — this one has reported, so its silence
    // means "not yet".
    const s = await makeScenario('silent-reporting@example.com');
    const item = await makeCard(s, 'A change across two repositories');

    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 81,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-work`, 81);
    await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [81] });
    expect(await ciStateOf(item.id)).toBe('passing');

    // A SECOND pull request in the SAME repository — which has reported before —
    // with no rows of its own.
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 82,
      headRef: `subtask/${item.identifier}-more`,
      title: `A change (subtask/${item.identifier}-more)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-more`, 82);
    expect(await ciStateOf(item.id)).toBe('running');
  });
});

describe('a FINISHED pull request with no check rows (MOTIR-5786)', () => {
  // The `running` arm above is for a pull request opened seconds ago. A MERGED or
  // CLOSED one with no rows will never report, so reading it as `running` pinned
  // the card there for ever — 212 finished cards on production's backfill dry
  // run. Every case here sits in a repository that HAS reported a check (PR #90
  // on another card), so the silence cannot be read as "this repository has no
  // CI"; that is the condition the defect needed.

  async function reportingRepo(s: Awaited<ReturnType<typeof makeScenario>>) {
    const other = await makeCard(s, 'Somebody else');
    await linkPrByIdentifier({
      identifier: other.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 90,
      headRef: `subtask/${other.identifier}-work`,
      title: `Other (subtask/${other.identifier}-work)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${other.identifier}-work`, 90);
    await ci({ conclusion: 'success', headSha: 'sha-other', prNumbers: [90] });
  }

  async function linkSilent(identifier: string, number: number) {
    await linkPrByIdentifier({
      identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef: `subtask/${identifier}-${number}`,
      title: `A change (subtask/${identifier}-${number})`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${identifier}-${number}`, number);
  }

  /** Finish the pull request on the mirror row, the way an old merge or a
   *  CI-skipping merge leaves it: terminal, with not one check row. */
  async function finish(number: number, merged: boolean) {
    const r = await adminDb.githubPullRequest.updateMany({
      where: { number, repo: { name: 'acme' } },
      data: { state: 'closed', merged },
    });
    expect(r.count).toBe(1);
  }

  async function recompute(workspaceId: string, workItemId: string) {
    return withWorkspaceServiceContext(workspaceId, (tx) =>
      recomputeWorkItemCiState(workItemId, tx),
    );
  }

  it.each([
    ['MERGED', true],
    ['CLOSED', false],
  ] as const)(
    'a card whose only member is %s with no checks recomputes to NULL, not running',
    async (label, merged) => {
      const s = await makeScenario(`finished-${label.toLowerCase()}@example.com`);
      await reportingRepo(s);
      const item = await makeCard(s, 'A change');
      await linkSilent(item.identifier, 91);
      // While it is OPEN, the just-opened arm still reads it as waiting.
      expect(await recompute(s.workspace.id, item.id)).toBe('running');

      await finish(91, merged);
      expect(await recompute(s.workspace.id, item.id)).toBeNull();
      expect(await ciStateOf(item.id)).toBeNull();
    },
  );

  it('one PASSING member plus one merged member with no checks recomputes to PASSING', async () => {
    const s = await makeScenario('finished-mixed@example.com');
    await reportingRepo(s);
    const item = await makeCard(s, 'A change in two pull requests');

    await linkSilent(item.identifier, 92);
    await ci({ conclusion: 'success', headSha: 'sha-92', prNumbers: [92] });
    await linkSilent(item.identifier, 93);
    expect(await recompute(s.workspace.id, item.id)).toBe('running');

    await finish(93, true);
    expect(await recompute(s.workspace.id, item.id)).toBe('passing');
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('an OPEN member with no checks still recomputes to RUNNING (the just-opened case is kept)', async () => {
    const s = await makeScenario('finished-open@example.com');
    await reportingRepo(s);
    const item = await makeCard(s, 'A change');
    await linkSilent(item.identifier, 94);
    expect(await recompute(s.workspace.id, item.id)).toBe('running');
    expect(await ciStateOf(item.id)).toBe('running');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MOTIR-5817 — the same rule through the OTHER arm: stuck at `pending`.
  //
  // MOTIR-5786 dropped a finished member with NO check rows (`state === null`).
  // A finished member whose last rows still say `pending` derives `running`, so
  // it survived that filter and pinned the card at `running` just the same. The
  // checks cannot settle — a completion event was lost, or the check was
  // abandoned at merge. On production these were the entire `passing → running`
  // column of the backfill's dry run: 40 cards, all of them `done`.
  //
  // `pending` is what the webhook records for any `check_run` whose status is
  // not `completed` (`lib/github/checkRuns.ts`), so a never-completed
  // `in_progress` run is exactly the production shape.
  // ───────────────────────────────────────────────────────────────────────────

  /** A check that starts and never completes — one `pending` row at `headSha`. */
  function pendingCheck(headSha: string, prNumbers: number[]) {
    return ci({ status: 'in_progress', conclusion: null, headSha, prNumbers });
  }

  it.each([
    ['MERGED', true],
    ['CLOSED', false],
  ] as const)(
    'a card whose only member is %s with a PENDING check recomputes to NULL, not running',
    async (label, merged) => {
      const s = await makeScenario(`pending-${label.toLowerCase()}@example.com`);
      await reportingRepo(s);
      const item = await makeCard(s, 'A change whose check never reported');
      await linkSilent(item.identifier, 95);
      await pendingCheck('sha-95', [95]);
      // While it is OPEN the check is genuinely still running.
      expect(await recompute(s.workspace.id, item.id)).toBe('running');

      await finish(95, merged);
      expect(await recompute(s.workspace.id, item.id)).toBeNull();
      expect(await ciStateOf(item.id)).toBeNull();
    },
  );

  it('one PASSING member plus one merged member stuck at PENDING recomputes to PASSING', async () => {
    // The production shape exactly: a done card reading `passing` off its green
    // member, which the backfill would have overwritten with `running`.
    const s = await makeScenario('pending-mixed@example.com');
    await reportingRepo(s);
    const item = await makeCard(s, 'A change in two pull requests');

    await linkSilent(item.identifier, 96);
    await ci({ conclusion: 'success', headSha: 'sha-96', prNumbers: [96] });
    await linkSilent(item.identifier, 97);
    await pendingCheck('sha-97', [97]);
    expect(await recompute(s.workspace.id, item.id)).toBe('running');

    await finish(97, true);
    expect(await recompute(s.workspace.id, item.id)).toBe('passing');
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('an OPEN member stuck at PENDING still recomputes to RUNNING', async () => {
    const s = await makeScenario('pending-open@example.com');
    await reportingRepo(s);
    const item = await makeCard(s, 'A change still building');
    await linkSilent(item.identifier, 98);
    await pendingCheck('sha-98', [98]);
    expect(await recompute(s.workspace.id, item.id)).toBe('running');
    expect(await ciStateOf(item.id)).toBe('running');
  });

  it('a MERGED member whose latest checks FAILED still makes the card FAILING', async () => {
    // The drop is scoped to `running`. A red merged pull request is a verdict,
    // and it stands.
    const s = await makeScenario('pending-red-merge@example.com');
    await reportingRepo(s);
    const item = await makeCard(s, 'A change that merged red');
    await linkSilent(item.identifier, 99);
    await ci({ conclusion: 'failure', headSha: 'sha-99', prNumbers: [99] });

    await finish(99, true);
    expect(await recompute(s.workspace.id, item.id)).toBe('failing');
    expect(await ciStateOf(item.id)).toBe('failing');
  });
});

describe('concurrency — two check events racing on one card (MOTIR-5470)', () => {
  it('the fold is taken under the card row lock, so the last commit sees both rows', async () => {
    // A read-derived write: what gets stored is computed from rows another
    // transaction may be inserting concurrently, and two workflows reporting at
    // once is the ordinary case rather than the exotic one. Without the row lock
    // both recomputes read the same pre-insert snapshot and race to store the
    // same stale answer — which looks identical to working until the RED one
    // loses. Real Postgres and a real warm pool: a count-then-write guard with no
    // `FOR UPDATE` only fails under exactly this.
    const s = await makeScenario('race@example.com');
    const item = await makeCard(s, 'A change with two workflows');
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 71,
      headRef: `subtask/${item.identifier}-work`,
      title: `A change (subtask/${item.identifier}-work)`,
    });
    await openPrIn(REPO_PROVIDER_ID, `subtask/${item.identifier}-work`, 71);

    // Two checks at ONE head commit, delivered simultaneously — one green, one
    // red. Whichever order they serialize in, the fold reads both rows, so the
    // card must end RED. A lost update would leave it green.
    await Promise.all([
      ci({ conclusion: 'success', headSha: 'sha-race', prNumbers: [71], name: 'lint' }),
      ci({ conclusion: 'failure', headSha: 'sha-race', prNumbers: [71], name: 'vitest' }),
    ]);

    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('two PULL REQUESTS reporting concurrently leave the fold of the final rows', async () => {
    // The acceptance criterion in its own words. The case above races two checks
    // on ONE pull request; this races the two DELIVERIES, which is the shape the
    // card is actually about — a card spanning two repositories whose builds
    // finish at the same moment. Either recompute must see both rows by the time
    // the second commits, and the fold of the final rows is `failing`.
    const s = await makeScenario('race-two-prs@example.com');
    const item = await makeCard(s, 'A change across two repositories');

    for (const [name, number, repoProviderId] of [
      ['acme', 91, REPO_PROVIDER_ID],
      ['acme-api', 92, OTHER_REPO_PROVIDER_ID],
    ] as const) {
      await linkPrByIdentifier({
        identifier: item.identifier,
        owner: 'moooon',
        name,
        number,
        headRef: `subtask/${item.identifier}-work`,
        title: `A change (subtask/${item.identifier}-work)`,
      });
      await openPrIn(repoProviderId, `subtask/${item.identifier}-work`, number);
    }

    await Promise.all([
      ci({ conclusion: 'success', headSha: 'sha-p', prNumbers: [91] }),
      ci({
        repoProviderId: OTHER_REPO_PROVIDER_ID,
        conclusion: 'failure',
        headSha: 'sha-q',
        prNumbers: [92],
      }),
    ]);

    expect(await ciStateOf(item.id)).toBe('failing');
  });
});
