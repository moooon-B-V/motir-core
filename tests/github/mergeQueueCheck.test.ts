import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE QUEUE'S FAILING CHECK (Story MOTIR-5461 · MOTIR-5633;
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 8), on a REAL
// Postgres, through the real webhook service. The `merge_group` bodies are the REAL
// deliveries MOTIR-5627 captured, and the failed check is the REAL check run on the
// pr-2830 merge group's commit (`tests/fixtures/github/merge-queue/`), each re-pointed
// at this fixture's installation, repository, pull requests and group commit.
//
// THE ORDERING LIMIT THIS CARD CHOSE: a check is BUFFERED on the queue attempt, which
// `checks_requested` writes before any of the group's checks can run. So a check that
// completes before the exit is copied onto it, and one that completes after it is
// attached to it — neither order loses it. What IS lost is a group whose
// `checks_requested` was never delivered (an installation without the `merge_group`
// event, or a delivery that failed): its checks attach to nothing, and the exit names
// no check. The last describe asserts exactly that.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-queue-check';
const REPO_PROVIDER_ID = '995';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REPOSITORY = { id: Number(REPO_PROVIDER_ID), full_name: 'moooon/acme' };
const GROUP = 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0';
const github = getGitProvider('github') as Required<GitProvider>;

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

/** The captured `checks_requested`, re-pointed at `numbers` and the group `sha`. */
function checksRequested(numbers: number[], sha = GROUP): Record<string, unknown> {
  const body = captured('merge-group-checks-requested');
  const group = body['merge_group'] as Record<string, unknown>;
  const prs = numbers.map((n) => `pr-${n}`).join('-');
  return {
    ...body,
    installation: INSTALLATION,
    repository: REPOSITORY,
    merge_group: {
      ...group,
      head_sha: sha,
      head_ref: `refs/heads/gh-readonly-queue/main/${prs}-${group['base_sha'] as string}`,
    },
  };
}

/** The captured failed check run, re-pointed at the group `sha`. */
function failedCheck(
  opts: { sha?: string; name?: string; id?: number; conclusion?: string; prs?: number[] } = {},
): Record<string, unknown> {
  const body = captured('check-run-failed-merge-group');
  const run = structuredClone(body['check_run']) as Record<string, unknown>;
  const id = opts.id ?? (run['id'] as number);
  return {
    ...body,
    installation: INSTALLATION,
    repository: REPOSITORY,
    check_run: {
      ...run,
      id,
      head_sha: opts.sha ?? GROUP,
      name: opts.name ?? run['name'],
      html_url: `https://github.com/moooon/acme/actions/runs/1/job/${id}`,
      conclusion: opts.conclusion ?? run['conclusion'],
      pull_requests: (opts.prs ?? []).map((number) => ({ number })),
    },
  };
}

function dequeued(number: number, headSha: string, reason = 'CI_FAILURE') {
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return {
    ...body,
    reason,
    number,
    installation: INSTALLATION,
    repository: REPOSITORY,
    pull_request: pr,
  };
}

const deliver = (event: string, body: Record<string, unknown>, deliveryId?: string) =>
  githubWebhookService.handleEvent(event, body, deliveryId ?? null);
let guid = 0;
const eject = (number: number, headSha: string, reason?: string) =>
  deliver('pull_request', dequeued(number, headSha, reason), `guid-${++guid}`);

async function makeScenario(email: string, numbers: number[]) {
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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
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
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A queued change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
  }
  return { ctx, item };
}

const pr = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const latestExit = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findFirstOrThrow({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'desc' },
  });
const attempts = async (number: number) =>
  adminDb.githubMergeQueueAttempt.findMany({
    where: { pullRequestId: (await pr(number)).id },
    orderBy: { createdAt: 'asc' },
  });
const checkRunRows = () => adminDb.githubCheckRun.count();

const VITEST = 'Vitest (7/12)';

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the seam reads the captured deliveries', () => {
  it('a real `checks_requested` names its pull request and group commit', () => {
    expect(github.parseMergeGroupAttemptEvent(captured('merge-group-checks-requested'))).toEqual({
      providerRepoId: '1246103300',
      headSha: '0a3359bd653343e89f4f88ddd6a10800178446ab',
      headRef: 'refs/heads/gh-readonly-queue/main/pr-2846-c50cbd7d636120565f616f55c31c6e16002c1f71',
      prNumbers: [2846],
    });
  });

  it('a real merge-group check run is an unlinked failure with its name and page', () => {
    expect(
      github.parseUnlinkedCheckFailure(captured('check-run-failed-merge-group')),
    ).toMatchObject({
      providerRepoId: '1246103300',
      headSha: '7a67057cafc9c60da0eaa8e4c4a283b460857c9b',
      name: VITEST,
      url: 'https://github.com/moooon-B-V/motir-core/actions/runs/34760457676/job/103732354674',
      completedAt: new Date('2026-09-13T14:27:21Z'),
    });
  });

  it('reads every `pr-<n>` a group ref names, and none from a ref that is not a queue', () => {
    expect(github.parseMergeGroupAttemptEvent(checksRequested([11, 12]))).toMatchObject({
      prNumbers: [11, 12],
    });
    const plain = checksRequested([11]);
    (plain['merge_group'] as Record<string, unknown>)['head_ref'] = 'refs/heads/pr-11-feature';
    expect(github.parseMergeGroupAttemptEvent(plain)).toBeNull();
  });

  it('is not an unlinked failure when it passed, is still running, or a pull request claims it', () => {
    expect(github.parseUnlinkedCheckFailure(failedCheck({ conclusion: 'success' }))).toBeNull();
    expect(github.parseUnlinkedCheckFailure(failedCheck({ prs: [11] }))).toBeNull();
    const running = failedCheck();
    (running['check_run'] as Record<string, unknown>)['status'] = 'in_progress';
    expect(github.parseUnlinkedCheckFailure(running)).toBeNull();
    // A cancelled check is a failure by the same map the CI feedback reads.
    expect(
      github.parseUnlinkedCheckFailure(failedCheck({ conclusion: 'cancelled' })),
    ).not.toBeNull();
  });
});

describe('the `merge_group` delivery records an attempt', () => {
  it('writes one attempt per named pull request, and a redelivery writes nothing', async () => {
    await makeScenario('attempt@example.com', [11]);

    expect(await deliver('merge_group', checksRequested([11]))).toEqual({
      event: 'merge_group',
      outcome: 'recorded',
      recorded: 1,
    });
    expect(await deliver('merge_group', checksRequested([11]))).toMatchObject({ recorded: 0 });
    expect(await attempts(11)).toEqual([
      expect.objectContaining({ headSha: GROUP, failingCheckName: null }),
    ]);
  });

  it('ignores `destroyed`, an unmirrored pull request, and an unknown installation', async () => {
    await makeScenario('attempt-ignore@example.com', [11]);
    const destroyed = { ...captured('merge-group-destroyed'), installation: INSTALLATION };
    expect(await deliver('merge_group', destroyed)).toEqual({
      event: 'merge_group',
      outcome: 'ignored_action',
    });
    expect(await deliver('merge_group', checksRequested([99]))).toMatchObject({
      outcome: 'unknown_pull_request',
    });
    expect(
      await deliver('merge_group', { ...checksRequested([11]), installation: { id: 'nope' } }),
    ).toMatchObject({ outcome: 'unknown_installation' });
    expect(
      await deliver('merge_group', { ...checksRequested([11]), repository: { id: 1 } }),
    ).toMatchObject({ outcome: 'unknown_repo' });
    const noRef = checksRequested([11]);
    delete (noRef['merge_group'] as Record<string, unknown>)['head_ref'];
    expect(await deliver('merge_group', noRef)).toMatchObject({ outcome: 'malformed' });
    expect(await attempts(11)).toEqual([]);
  });
});

describe('a failed merge-group check names the exit', () => {
  it('the check completes BEFORE the exit (the captured order) — the exit copies it', async () => {
    await makeScenario('before@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    const before = await checkRunRows();

    await deliver('check_run', failedCheck());
    await eject(11, 'sha-a');

    expect(await latestExit(11)).toMatchObject({
      disposition: 'failure',
      failingCheckName: VITEST,
      failingCheckUrl: expect.stringMatching(/\/job\/103732354674$/),
    });
    // ⚠️ The pull request's OWN CI state is untouched: no `github_check_run` row.
    expect(await checkRunRows()).toBe(before);
  });

  it('the check completes AFTER the exit — it is attached to the exit already written', async () => {
    await makeScenario('after@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await eject(11, 'sha-a');
    expect(await latestExit(11)).toMatchObject({ failingCheckName: null });

    await deliver('check_run', failedCheck());

    expect(await latestExit(11)).toMatchObject({ failingCheckName: VITEST });
    expect((await attempts(11))[0]).toMatchObject({ failingCheckName: VITEST });
  });

  it('the FIRST failure to complete wins, and a redelivered check changes nothing', async () => {
    await makeScenario('first@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await deliver('check_run', failedCheck());
    await deliver('check_run', failedCheck({ name: 'CI complete', id: 103738225045 }));
    await deliver('check_run', failedCheck());
    await eject(11, 'sha-a');
    await deliver('check_run', failedCheck({ name: 'CI complete', id: 103738225045 }));

    expect(await latestExit(11)).toMatchObject({ failingCheckName: VITEST });
    expect(await attempts(11)).toEqual([expect.objectContaining({ failingCheckName: VITEST })]);
  });

  it('a group naming two pull requests names the check on each one’s exit', async () => {
    await makeScenario('pair@example.com', [11, 12]);
    await deliver('merge_group', checksRequested([11, 12]));
    await eject(11, 'sha-a');
    await deliver('check_run', failedCheck());
    await eject(12, 'sha-b');

    expect(await latestExit(11)).toMatchObject({ failingCheckName: VITEST });
    expect(await latestExit(12)).toMatchObject({ failingCheckName: VITEST });
  });

  it('a later group’s check names only the exit that group ended in', async () => {
    await makeScenario('regroup@example.com', [11]);
    const second = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
    await deliver('merge_group', checksRequested([11]));
    await eject(11, 'sha-a', 'MANUAL');
    // Queued again: a NEW group, which fails.
    await deliver('merge_group', checksRequested([11], second));
    // A late check from the FIRST group attaches to its attempt, and not to anything
    // that group did not end in.
    await deliver('check_run', failedCheck({ name: 'late', id: 1 }));
    await deliver('check_run', failedCheck({ sha: second }));
    await eject(11, 'sha-a');

    expect(await latestExit(11)).toMatchObject({ failingCheckName: VITEST });
    expect((await attempts(11)).map((a) => a.failingCheckName)).toEqual(['late', VITEST]);
  });
});

describe('what a check does NOT name', () => {
  it('a passing merge-group check attaches nothing', async () => {
    await makeScenario('green@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await deliver('check_run', failedCheck({ conclusion: 'success' }));
    await eject(11, 'sha-a');
    expect(await latestExit(11)).toMatchObject({ failingCheckName: null });
    expect((await attempts(11))[0]).toMatchObject({ failingCheckName: null });
  });

  it('a pull request with no exit keeps the check on its attempt, and nothing errors', async () => {
    await makeScenario('no-exit@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await expect(deliver('check_run', failedCheck())).resolves.toBeDefined();
    expect(await adminDb.githubPullRequestQueueExit.count()).toBe(0);
    expect((await attempts(11))[0]).toMatchObject({ failingCheckName: VITEST });
  });

  it('a NEUTRAL exit names no check, whatever the attempt holds', async () => {
    await makeScenario('neutral@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await deliver('check_run', failedCheck());
    await eject(11, 'sha-a', 'MANUAL');
    expect(await latestExit(11)).toMatchObject({ disposition: 'neutral', failingCheckName: null });
  });

  it('a failing check a pull request claims is the ordinary CI path, not a queue check', async () => {
    await makeScenario('claimed@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await deliver('check_run', failedCheck({ prs: [11] }));
    expect((await attempts(11))[0]).toMatchObject({ failingCheckName: null });
  });

  it('a check from an unknown installation attaches nothing', async () => {
    await makeScenario('check-unknown@example.com', [11]);
    await deliver('merge_group', checksRequested([11]));
    await deliver('check_run', { ...failedCheck(), installation: { id: 'nope' } });
    expect((await attempts(11))[0]).toMatchObject({ failingCheckName: null });
  });
});

describe('the ordering limit: a group whose `checks_requested` never arrived', () => {
  it('its failed check attaches to nothing, and the exit names no check', async () => {
    await makeScenario('never@example.com', [11]);
    const before = await checkRunRows();

    await deliver('check_run', failedCheck());
    await eject(11, 'sha-a');

    expect(await attempts(11)).toEqual([]);
    expect(await latestExit(11)).toMatchObject({ disposition: 'failure', failingCheckName: null });
    expect(await checkRunRows()).toBe(before);
  });
});
