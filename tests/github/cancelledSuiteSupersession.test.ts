import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { derivePrCiState } from '@/lib/github/prCiState';
import { liveCheckRows } from '@/lib/github/checkSuites';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3209 — A CANCELLED RUN MUST NOT DECIDE A CARD'S CI VERDICT.
//
// The ingestion key was `(pullRequest, commitSha, checkName)`, so two workflow
// runs at ONE head sha merged by check NAME. `cancel-in-progress` (MOTIR-3106)
// makes that ordinary — a label added seconds after `gh pr create` starts a
// second run and the first is cancelled — and the two runs do not use the same
// names, so the loser's rows outlive the winner's exactly where the names differ:
//
//  * a matrix job cancelled BEFORE expansion reports the literal template as its
//    name (`Vitest (${{ matrix.shard }}/${{ matrix.total }})`), which the winner's
//    `Vitest (1/3)` can never overwrite — a different key;
//  * `Deploy to Fly` is the same trap from the other side: `cancelled` → failure
//    in the loser, `skipped` → neutral in the winner, and a neutral records
//    nothing, so nothing ever clears it.
//
// Both derivations then read a `failure` at the head sha forever: the ONE
// feedback comment says "❌ CI failed", naming checks that are green on GitHub,
// and `promoteDeliveredCardsOnGreen` (MOTIR-3006) never runs, so the card is
// stranded at `implemented`. Observed on motir-core PR #2192 / MOTIR-3206.
//
// The fix records the check's SUITE identity on the row and supersedes by RUN:
// a suite at a sha is retired once a NEWER suite at that sha reports a check of
// the same name. Real Postgres, the real webhook service, the real provider seam.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci-supersede';
const REPO_PROVIDER_ID = '991';

/** The head sha both runs of the fixture report against — PR #2192's, shortened. */
const SHA = '82d6e346';

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

async function openPr(headBranch: string, number: number) {
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
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

/** A card whose own pull request is open — the sync links it and moves it to
 *  `implemented`, which is the state CI green is entitled to move it out of. */
async function cardWithPr(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  number: number,
) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await openPr(`subtask/${item.identifier}-work`, number);
  expect(await statusOf(item.id)).toBe('implemented');
  return item;
}

/** One `check_run` delivery, carrying the SUITE its run belongs to — the field
 *  the defect is about. `suiteId: null` is the legacy / suite-less shape. */
function checkRun(opts: {
  name: string;
  conclusion: string | null;
  suiteId: string | null;
  status?: string;
  headSha?: string;
  prNumbers?: number[];
}) {
  return githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha ?? SHA,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      name: opts.name,
      check_suite: {
        head_branch: null,
        ...(opts.suiteId === null ? {} : { id: Number(opts.suiteId) }),
      },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}
async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}
async function feedbackBody(workItemId: string): Promise<string> {
  const rows = await adminDb.comment.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'asc' },
  });
  expect(rows).toHaveLength(1); // still ONE comment per (change request, sha) — MOTIR-2946
  return rows[0]!.bodyMd;
}

/**
 * The PR #2192 fixture, in order: the CANCELLED run's rows first, then the
 * winning run's at the SAME sha under a different suite.
 *
 * Run A is cancelled before its matrix expands, so it reports the literal
 * template as a name and a cancelled `Deploy to Fly`. Run B reports the expanded
 * leg and SKIPS the deploy — a neutral, which records nothing at all.
 */
async function ingestBothRuns(prNumber: number) {
  const CANCELLED = '87626130152';
  const WINNER = '87626227873';
  const results = [];

  for (const name of ['TypeScript', 'Vitest (${{ matrix.shard }}/${{ matrix.total }})']) {
    results.push(
      await checkRun({ name, conclusion: 'cancelled', suiteId: CANCELLED, prNumbers: [prNumber] }),
    );
  }
  results.push(
    await checkRun({
      name: 'Deploy to Fly',
      conclusion: 'cancelled',
      suiteId: CANCELLED,
      prNumbers: [prNumber],
    }),
  );

  results.push(
    await checkRun({
      name: 'TypeScript',
      conclusion: 'success',
      suiteId: WINNER,
      prNumbers: [prNumber],
    }),
  );
  // The mirror trap, mid-run: `skipped` maps to NEUTRAL, and a neutral records
  // nothing at all — so the cancelled run's `Deploy to Fly` failure is never
  // overwritten and only supersession can retire it.
  const skipped = await checkRun({
    name: 'Deploy to Fly',
    conclusion: 'skipped',
    suiteId: WINNER,
    prNumbers: [prNumber],
  });
  expect(skipped).toMatchObject({ outcome: 'ignored_pending' });
  results.push(skipped);

  results.push(
    await checkRun({
      name: 'Vitest (1/3)',
      conclusion: 'success',
      suiteId: WINNER,
      prNumbers: [prNumber],
    }),
  );
  return results;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a cancelled run is superseded by the run that replaced it (MOTIR-3209)', () => {
  it('derives PASSING and says so — naming no check the winning run did not report', async () => {
    const s = await makeScenario('supersede-pass@example.com');
    const item = await cardWithPr(s, 'A change', 21);

    const results = await ingestBothRuns(21);

    expect(results.at(-1)).toMatchObject({ outcome: 'verified', ciState: 'passing' });
    expect(await ciStateOf(item.id)).toBe('passing');

    const body = await feedbackBody(item.id);
    expect(body).toContain('✅');
    expect(body).toContain('CI passing');
    // The two names the cancelled run owns alone are exactly the ones a
    // name-keyed table could never overwrite. Neither may reach a reader.
    expect(body).not.toContain('${{');
    expect(body).not.toContain('Deploy to Fly');
    expect(body).not.toContain('CI failed');
    // Two checks, not five: the superseded suite's rows are not part of the set.
    expect(body).toContain('all 2 checks succeeded');
  });

  it('promotes the card the same green verdict says is reviewable', async () => {
    const s = await makeScenario('supersede-promote@example.com');
    const item = await cardWithPr(s, 'A change', 22);

    const results = await ingestBothRuns(22);

    // The promotion reads `derivePrCiState`; the comment reads `deriveCiState`.
    // ONE verdict means the ID comes back — not just a status that agrees — and
    // it comes back EXACTLY ONCE: the delivery that first turns the aggregate
    // green promotes, and every later green finds nothing left at `implemented`.
    expect(results.filter((r) => 'promoted' in r)).toEqual([
      expect.objectContaining({ promoted: [item.id], ciState: 'passing' }),
    ]);
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('is one verdict — the derivation drops the rows, the INGEST still has them', async () => {
    // AC 3, and the reason it is phrased over the derivation: the superseded
    // rows are still ON DISK (a cancelled run really did report them, and the
    // Development surface's "N checks" is entitled to see the history). What
    // must be true is that NEITHER derivation reads one — the comment's
    // `deriveCiState` and the promotion's `derivePrCiState` agree because they
    // filter through the SAME function, not because the table was pruned.
    const s = await makeScenario('supersede-one-verdict@example.com');
    const item = await cardWithPr(s, 'A change', 27);

    await ingestBothRuns(27);

    const stored = await adminDb.githubCheckRun.findMany({ orderBy: { createdAt: 'asc' } });
    // Five rows: three from the cancelled run, two from the winner. The winner's
    // skipped deploy recorded nothing, which is what leaves the stale failure.
    expect(stored).toHaveLength(5);
    expect(stored.filter((r) => r.conclusion === 'failure')).toHaveLength(3);

    const live = liveCheckRows(stored);
    expect(live.map((r) => r.checkName).sort()).toEqual(['TypeScript', 'Vitest (1/3)']);
    expect(live.every((r) => r.conclusion === 'success')).toBe(true);

    // Both derivations, over the same rows, one answer.
    expect(derivePrCiState(stored)).toBe('passing');
    expect(await ciStateOf(item.id)).toBe('passing');
    expect(await feedbackBody(item.id)).toContain('CI passing');
  });

  it('supersedes per WORKFLOW, never per sha — a failing CodeQL suite still counts', async () => {
    // Two DIFFERENT workflows' suites live at one sha (motir-core runs `ci.yml`
    // and `codeql.yml`, and each Actions workflow run is its own check suite).
    // "Newest suite at the sha wins" would let the CI re-run hide CodeQL's own
    // verdict; superseding is per workflow, so both are read.
    const s = await makeScenario('supersede-codeql@example.com');
    const item = await cardWithPr(s, 'A change', 23);

    await checkRun({ name: 'TypeScript', conclusion: 'cancelled', suiteId: '1', prNumbers: [23] });
    await checkRun({
      name: 'Analyze (javascript-typescript)',
      conclusion: 'failure',
      suiteId: '2',
      prNumbers: [23],
    });
    // The CI re-run: it retires suite 1 (same workflow, same check name) and
    // must NOT retire suite 2, which shares no name with either.
    const last = await checkRun({
      name: 'TypeScript',
      conclusion: 'success',
      suiteId: '3',
      prNumbers: [23],
    });

    // The delivery's OWN conclusion is a success; the AGGREGATE it lands in is
    // not, because CodeQL's suite was never retired.
    expect(last).toMatchObject({ outcome: 'verified', ciState: 'failing' });
    expect(last).not.toHaveProperty('promoted');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await feedbackBody(item.id)).toContain('Analyze (javascript-typescript)');
  });

  it('a REPLACED suite loses even when its rows are the only failures left', async () => {
    // The narrow reading — "drop rows whose name contains `${{`" — would leave
    // the cancelled `Deploy to Fly`; the narrow reading from the other side —
    // "let a neutral overwrite" — would leave the matrix template. Superseding by
    // run answers both, and this asserts the second half on its own.
    const s = await makeScenario('supersede-deploy@example.com');
    const item = await cardWithPr(s, 'A change', 24);

    await checkRun({
      name: 'Deploy to Fly',
      conclusion: 'cancelled',
      suiteId: '10',
      prNumbers: [24],
    });
    await checkRun({ name: 'TypeScript', conclusion: 'cancelled', suiteId: '10', prNumbers: [24] });
    const last = await checkRun({
      name: 'TypeScript',
      conclusion: 'success',
      suiteId: '11',
      prNumbers: [24],
    });

    expect(last).toMatchObject({ ciState: 'passing' });
    expect(await statusOf(item.id)).toBe('in_review');
  });

  it('an unrelated suite is NOT retired — a run that shares no check name survives', async () => {
    const s = await makeScenario('supersede-unrelated@example.com');
    const item = await cardWithPr(s, 'A change', 25);

    await checkRun({ name: 'CodeQL', conclusion: 'failure', suiteId: '20', prNumbers: [25] });
    const last = await checkRun({
      name: 'TypeScript',
      conclusion: 'success',
      suiteId: '21',
      prNumbers: [25],
    });

    expect(last).toMatchObject({ ciState: 'failing' });
    expect(await statusOf(item.id)).toBe('implemented');
  });

  it('rows carrying NO suite identity derive exactly what they derive today', async () => {
    // The legacy shape, and the one every pre-migration row degrades to: a
    // commit-`status` event has no suite at all, so two checks at one sha are one
    // group that supersedes nothing and is superseded by nothing.
    const s = await makeScenario('supersede-legacy@example.com');
    const item = await cardWithPr(s, 'A change', 26);

    await checkRun({ name: 'Vitest', conclusion: 'failure', suiteId: null, prNumbers: [26] });
    const last = await checkRun({
      name: 'TypeScript',
      conclusion: 'success',
      suiteId: null,
      prNumbers: [26],
    });

    // The earlier row still counts — one group, nothing retired — so the later
    // green does NOT flip the verdict and the card never becomes reviewable.
    expect(last).toMatchObject({ ciState: 'failing' });
    expect(await feedbackBody(item.id)).toContain('`Vitest`');
    expect(await statusOf(item.id)).toBe('implemented');
  });
});
