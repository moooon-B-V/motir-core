import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · Subtask 7.10.6 / MOTIR-894 — the CI feedback loop, against a real
// Postgres (the motir-core convention). Covers: a check_suite / check_run
// terminal conclusion → a passing note or failure summary on the LINKED subtask +
// the item's `ciState` verification signal; idempotency on (pr, headSha,
// checkName) under redelivery AND a re-run that changes conclusion (comment
// updated in place, never duplicated); the clean no-op paths (a PR with no linked
// work item; a NEUTRAL conclusion), the pending-RECORDED path (MOTIR-1579 —
// a pending row for the Development surface, with no terminal side-effects); PR resolution by the payload's
// PR-number list AND the head-branch fallback; and the Story-level "N of M
// verified" roll-up computed via the EXISTING `getProjectRoadmap` progress
// aggregation (not a parallel path).

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ci';
const REPO_PROVIDER_ID = '777';

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
      { providerRepoId: REPO_PROVIDER_ID, owner: 'moooon', name: 'acme', defaultBranch: 'main' },
    ],
  });
  return { user, workspace, project, ctx };
}

/** Open a PR through the pull_request webhook so its row is stored and linked to
 *  `identifier` (via the head ref) — mirrors reality: the PR opens (link) → then
 *  CI runs against it. `identifier: null` opens a PR that resolves to NO work
 *  item (a non-matching head ref). Returns the PR number + head branch. */
async function openPr(identifier: string | null, number: number) {
  const headBranch = identifier ? `feat/${identifier}-work` : 'feat/no-match-branch';
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: identifier ?? 'Unrelated change',
      head: { ref: headBranch },
      user: { id: 4242 },
    },
  });
  return { number, headBranch };
}

function checkSuitePayload(opts: {
  conclusion: string | null;
  status?: string;
  headSha: string;
  headBranch?: string | null;
  prNumbers?: number[];
  appSlug?: string;
  repoId?: number;
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: opts.headBranch === undefined ? null : opts.headBranch,
      status: opts.status ?? 'completed',
      conclusion: opts.conclusion,
      app: { slug: opts.appSlug ?? 'github-actions' },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

function checkRunPayload(opts: {
  conclusion: string | null;
  name?: string;
  headSha: string;
  headBranch?: string | null;
  prNumbers?: number[];
}) {
  return {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: opts.name ?? 'build',
      check_suite: { head_branch: opts.headBranch ?? null },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

async function commentsOn(workItemId: string) {
  return db.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}
async function ciStateOf(workItemId: string): Promise<string | null> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.ciState;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('githubWebhookService — CI feedback (MOTIR-894)', () => {
  it('a passing check_suite posts a passing note and marks the subtask verified', async () => {
    const s = await makeScenario('pass@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({
      event: 'ci',
      outcome: 'verified',
      workItemId: item.id,
      ciState: 'passing',
    });
    expect(await ciStateOf(item.id)).toBe('passing');

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI passing');

    const checkRows = await db.githubCheckRun.findMany();
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0]).toMatchObject({ conclusion: 'success', commitSha: 'sha1' });
    expect(checkRows[0]!.feedbackCommentId).toBe(comments[0]!.id);
  });

  it('a failing check_suite posts the failure summary + link and flips the item to not-ready', async () => {
    const s = await makeScenario('fail@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({
      event: 'ci',
      outcome: 'failed',
      workItemId: item.id,
      ciState: 'failing',
    });
    expect(await ciStateOf(item.id)).toBe('failing');

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('CI failed');
    expect(comments[0]!.bodyMd).toContain('/pull/7/checks'); // the "view checks" link
  });

  it('is idempotent under REDELIVERY — the same conclusion twice never duplicates the comment', async () => {
    const s = await makeScenario('redeliver@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    const payload = checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] });

    const first = await githubWebhookService.handleEvent('check_suite', payload);
    expect(first).toMatchObject({ outcome: 'verified' });
    const second = await githubWebhookService.handleEvent('check_suite', payload);
    expect(second).toMatchObject({ outcome: 'noop' });

    expect(await commentsOn(item.id)).toHaveLength(1);
    expect(await db.githubCheckRun.count()).toBe(1);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a RE-RUN that changes conclusion (same pr/sha/check) UPDATES the comment in place', async () => {
    const s = await makeScenario('rerun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(await ciStateOf(item.id)).toBe('failing');

    // A re-run of the SAME suite at the SAME commit now passes.
    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });

    const comments = await commentsOn(item.id);
    expect(comments).toHaveLength(1); // updated in place — NOT a second comment
    expect(comments[0]!.bodyMd).toContain('CI passing');
    expect(await db.githubCheckRun.count()).toBe(1);
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('a check event for a PR with NO linked work item is a clean no-op', async () => {
    const s = await makeScenario('nowi@example.com');
    // Also make a REAL item + PR so we can prove nothing leaks onto it.
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);
    // PR #99 opens but resolves to no work item (non-matching head ref).
    await openPr(null, 99);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'shaX', prNumbers: [99] }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'no_work_item' });

    expect(await db.githubCheckRun.count()).toBe(0); // nothing recorded
    expect(await commentsOn(item.id)).toHaveLength(0); // the real item is untouched
    expect(await ciStateOf(item.id)).toBeNull();
  });

  it('an in-flight (pending) conclusion is RECORDED as a pending row — still no comment, no signal (MOTIR-1579)', async () => {
    const s = await makeScenario('pending@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: null,
        status: 'in_progress',
        headSha: 'sha1',
        prNumbers: [7],
      }),
    );
    // The row exists (the Development surface derives "Checks running" from
    // it) but the TERMINAL side-effects stay terminal-only (MOTIR-894): no
    // feedback comment, no ciState flip.
    expect(res).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    const rows = await db.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ conclusion: 'pending', feedbackCommentId: null });
    expect(await commentsOn(item.id)).toHaveLength(0);
    expect(await ciStateOf(item.id)).toBeNull();
  });

  it('a NEUTRAL (skipped / stale) conclusion stays a full no-op — nothing recorded', async () => {
    const s = await makeScenario('neutral@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'neutral', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'ignored_pending' });
    expect(await db.githubCheckRun.count()).toBe(0);
    expect(await commentsOn(item.id)).toHaveLength(0);
    expect(await ciStateOf(item.id)).toBeNull();
  });

  it('a pending RE-RUN preserves the feedback-comment link, and the later terminal conclusion updates that SAME comment', async () => {
    const s = await makeScenario('pending-rerun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    // 1. Terminal success → the passing note + ciState 'passing'.
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    const afterSuccess = await commentsOn(item.id);
    expect(afterSuccess).toHaveLength(1);
    expect(await ciStateOf(item.id)).toBe('passing');

    // 2. A re-run starts (pending at the SAME pr/sha/check): the row converges
    //    to 'pending' but KEEPS the comment link, and the item's terminal-only
    //    signal is untouched.
    const pendingRes = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: null,
        status: 'in_progress',
        headSha: 'sha1',
        prNumbers: [7],
      }),
    );
    expect(pendingRes).toMatchObject({ event: 'ci', outcome: 'pending_recorded' });
    const rows = await db.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conclusion).toBe('pending');
    expect(rows[0]!.feedbackCommentId).toBe(afterSuccess[0]!.id);
    expect(await ciStateOf(item.id)).toBe('passing'); // terminal-only signal untouched

    // 3. The re-run concludes FAILURE → the SAME comment updates in place
    //    (never a duplicate) and the signal flips.
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'failure', headSha: 'sha1', prNumbers: [7] }),
    );
    const afterFailure = await commentsOn(item.id);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]!.id).toBe(afterSuccess[0]!.id);
    expect(afterFailure[0]!.bodyMd).toContain('CI failed');
    expect(await ciStateOf(item.id)).toBe('failing');
  });

  it('resolves the PR by HEAD BRANCH when the payload carries no PR-number list', async () => {
    const s = await makeScenario('branch@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    const pr = await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: 'sha1',
        prNumbers: [], // no PR list — must fall back to the branch
        headBranch: pr.headBranch,
      }),
    );
    expect(res).toMatchObject({ outcome: 'verified', workItemId: item.id });
    expect(await ciStateOf(item.id)).toBe('passing');
  });

  it('handles a check_run event (per-check) the same way', async () => {
    const s = await makeScenario('checkrun@example.com');
    const item = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A change' },
      s.ctx,
    );
    await openPr(item.identifier, 7);

    const res = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7], name: 'lint' }),
    );
    expect(res).toMatchObject({ event: 'ci', outcome: 'verified', ciState: 'passing' });
    expect(await ciStateOf(item.id)).toBe('passing');
    const rows = await db.githubCheckRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkName: 'lint' });
  });

  it('the Story shows "N of M verified" via the EXISTING roadmap roll-up', async () => {
    const s = await makeScenario('rollup@example.com');
    const story = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'story', title: 'A story' },
      s.ctx,
    );
    const sub1 = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'sub 1', parentId: story.id },
      s.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'subtask', title: 'sub 2', parentId: story.id },
      s.ctx,
    );

    // Drive a real CI success against sub1 → its ciState flips to passing.
    await openPr(sub1.identifier, 11);
    await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [11] }),
    );

    // The Story-level meter is the SAME getProjectRoadmap rollup, now carrying
    // `verified` alongside done/total: 1 of the 2 subtasks is CI-verified.
    const roadmap = await workItemsService.getProjectRoadmap(s.project.id, null, s.ctx);
    const storyNode = roadmap.nodes.find((n) => n.id === story.id)!;
    expect(storyNode.progress).toEqual({ done: 0, total: 2, verified: 1 });
  });
});
