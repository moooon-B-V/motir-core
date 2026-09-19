import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

const doors = vi.hoisted(() => ({
  ctx: null as { userId: string; workspaceId: string } | null,
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () => ({ ok: true, ctx: doors.ctx }),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => ({ user: { id: doors.ctx?.userId } }),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => doors.ctx,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { ApprovalGateAlreadyRequeuedError } from '@/lib/approvalGates/errors';
import { derivePrCiState } from '@/lib/github/prCiState';
import { QUEUE_EXIT_REASONS, classifyQueueExit } from '@/lib/mergeQueue/queueExit';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { POST as queueAgainRoute } from '@/app/api/work-items/[id]/pull-requests/[pullRequestId]/queue-again/route';
import { queueAgainAutoAction } from '@/app/(authed)/items/[key]/approvalGateActions';

// ═══════════════════════════════════════════════════════════════════════════════
// THE STORY GATE — A PULL REQUEST THE MERGE QUEUE EJECTS (Story MOTIR-5461 · MOTIR-5636)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Each code child proved its own half: the workflow edges (MOTIR-5630), the ejection
// arm (MOTIR-5632), the failing check (MOTIR-5633), Queue again (MOTIR-5634) and the
// frame (MOTIR-5635). This file drives them TOGETHER, on a real Postgres, through
// `githubWebhookService.handleEvent` with the REAL captured deliveries
// (`tests/fixtures/github/merge-queue/`), and asserts the seams no unit owns:
//
//   1. the whole manual loop — green → ONE gate → approve and merge → eject → a green
//      check changes nothing → Queue again → merges → done;
//   2. the re-arm — a push after the ejection raises exactly ONE fresh gate;
//   3. auto mode — eject from in_review, a person's Queue again, once;
//   4. every reason in the amendment's map, from the SAME constant the handler reads;
//   5. redelivery and order;
//   6. the failing check, and the pull request's own CI state untouched;
//   7. the architecture: who may import the new repositories, and how status is written;
//   8. no per-pull-request gate, anywhere, after every scenario.
//
// The host is the seam's `mergeChangeRequest`, stubbed — the one call that leaves the
// process. Nothing Motir decides is mocked: not `applyStatusTransition`, not the raise,
// not the exit repository.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-ejection-story';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };
const REPOS = { web: '7001', api: '7002' } as const;
type RepoName = keyof typeof REPOS;
const KIND = 'pull_request_approval';
const github = getGitProvider('github') as Required<GitProvider>;

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

const repository = (repo: RepoName) => ({ id: Number(REPOS[repo]) });

function dequeuedBody(repo: RepoName, number: number, headSha: string, reason: string) {
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headSha };
  return {
    ...body,
    reason,
    number,
    installation: INSTALLATION,
    repository: repository(repo),
    pull_request: pr,
  };
}

let guid = 0;
const nextGuid = () => `story-guid-${++guid}`;
const eject = (
  repo: RepoName,
  number: number,
  headSha: string,
  reason = 'CI_FAILURE',
  deliveryId = nextGuid(),
) =>
  githubWebhookService.handleEvent(
    'pull_request',
    dequeuedBody(repo, number, headSha, reason),
    deliveryId,
  );

const green = (repo: RepoName, number: number, headSha: string, name = 'CI complete') =>
  githubWebhookService.handleEvent('check_run', {
    action: 'completed',
    installation: INSTALLATION,
    repository: repository(repo),
    check_run: {
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      name,
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

const pending = (repo: RepoName, number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_run', {
    action: 'created',
    installation: INSTALLATION,
    repository: repository(repo),
    check_run: {
      head_sha: headSha,
      status: 'in_progress',
      conclusion: null,
      name: 'CI complete',
      check_suite: { id: 1, head_branch: null },
      pull_requests: [{ number }],
    },
  });

function prDelivery(
  repo: RepoName,
  action: string,
  number: number,
  headRef: string,
  opts: { merged?: boolean; headSha?: string } = {},
) {
  return githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: repository(repo),
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? new Date().toISOString() : null,
      title: 'A change',
      head: { ref: headRef, ...(opts.headSha ? { sha: opts.headSha } : {}) },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string, mode: 'manual' | 'auto') {
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
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: mode } });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: (Object.keys(REPOS) as RepoName[]).map((name) => ({
      providerRepoId: REPOS[name],
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

const headRefOf = (identifier: string, number: number) => `subtask/${identifier}-${number}`;

async function card(s: Scenario, prs: Array<[RepoName, number]>) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Throttle the public API' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const [repo, number] of prs) {
    const headRef = headRefOf(item.identifier, number);
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: repo,
      number,
      headRef,
    });
    await prDelivery(repo, 'opened', number, headRef);
  }
  return item;
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) =>
  adminDb.githubPullRequest.findFirstOrThrow({ where: { number }, include: { checkRuns: true } });
const gates = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'asc' },
  });
const awaiting = async (workItemId: string) =>
  (await gates(workItemId)).filter((g) => g.state === 'awaiting');
const exitsOf = async (number: number) =>
  adminDb.githubPullRequestQueueExit.findMany({
    where: { pullRequestId: (await prRow(number)).id },
    orderBy: { createdAt: 'asc' },
  });
const queueRef = async (number: number) => (await prRow(number)).mergeOutcomeRef;

function stubHost(answer: (number: number) => MergeChangeRequestResult) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answer(args.number));
}
const enqueueAll = () => stubHost((n) => ({ outcome: 'enqueued', entryId: `MQE_${n}` }));

/** A manual card over web#7 and api#12, green, approved and merged into the queue by the
 *  REAL press. */
async function approvedIntoTheQueue(email: string) {
  const s = await makeScenario(email, 'manual');
  const item = await card(s, [
    ['web', 7],
    ['api', 12],
  ]);
  await green('web', 7, 'sha-web');
  await green('api', 12, 'sha-api');
  expect(await statusOf(item.id)).toBe('in_review');
  const [gate, ...more] = await awaiting(item.id);
  expect(more).toEqual([]);
  enqueueAll();
  const { members } = await pullRequestMergeService.approveAndMerge(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, source: 'ui' },
    s.ctx,
  );
  expect(members.map((m) => m.outcome)).toEqual(['enqueued', 'enqueued']);
  expect(await statusOf(item.id)).toBe('approved');
  expect(await queueRef(7)).toBe('queue:MQE_7');
  expect(await queueRef(12)).toBe('queue:MQE_12');
  const approved = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate!.id } });
  return { s, item, approved };
}

const queueAgain = async (s: Scenario, approvalGateId: string, number: number) =>
  pullRequestMergeService.retryApproveAndMergeMember(
    { approvalGateId, pullRequestId: (await prRow(number)).id, noteMd: null, source: 'ui' },
    s.ctx,
  );

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  sent.length = 0;
  vi.restoreAllMocks();
});

// 8 · NO PER-PULL-REQUEST GATE — after every scenario in this file.
afterEach(async () => {
  expect(await adminDb.approvalGate.count({ where: { kind: 'pull_request_merge' } })).toBe(0);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('1 · the whole manual loop', () => {
  it('eject → a green check at the same head changes nothing → Queue again is refused → both merge → done', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('loop@example.com');

    // A failure exit for web#7.
    expect(await eject('web', 7, 'sha-web')).toMatchObject({
      outcome: 'recorded',
      moved: [item.identifier],
    });
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await queueRef(7)).toBeNull();
    expect(await queueRef(12)).toBe('queue:MQE_12');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );

    // Guard (a): a green check at web#7's SAME head neither promotes nor re-asks.
    await green('web', 7, 'sha-web', 'Lint');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);

    // Queue again on a FAILURE exit is RETIRED (§4 FOURTH AMENDMENT, point 4; MOTIR-5802):
    // the old approval is not reused, nothing is claimed, and no host is called.
    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' },
    });
    expect(host).not.toHaveBeenCalled();
    expect(await queueRef(7)).toBeNull();
    expect((await exitsOf(7))[0]!.requeuedAt).toBeNull();

    // Both merges land (web#7 by hand on GitHub): done.
    await prDelivery('api', 'closed', 12, headRefOf(item.identifier, 12), { merged: true });
    await prDelivery('web', 'closed', 7, headRefOf(item.identifier, 7), { merged: true });
    expect(await statusOf(item.id)).toBe('done');
    expect(await gates(item.id)).toHaveLength(1);
  });
});

describe('2 · the re-arm', () => {
  it('a push after the ejection raises exactly ONE fresh gate over the new head, and the old exit cannot be queued again', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('rearm@example.com');
    await eject('web', 7, 'sha-web');
    expect(await statusOf(item.id)).toBe('implemented');

    await prDelivery('web', 'synchronize', 7, headRefOf(item.identifier, 7), {
      headSha: 'sha-web-2',
    });
    await pending('web', 7, 'sha-web-2');
    expect(await statusOf(item.id)).toBe('implemented');
    expect(await awaiting(item.id)).toEqual([]);

    await green('web', 7, 'sha-web-2');
    expect(await statusOf(item.id)).toBe('in_review');
    const fresh = await awaiting(item.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.subjectVersion).toContain('moooon/web#7@sha-web-2');
    expect(await adminDb.approvalGate.findUniqueOrThrow({ where: { id: approved.id } })).toEqual(
      approved,
    );

    const host = enqueueAll();
    host.mockClear();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({
      outcome: 'refused',
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    expect(host).not.toHaveBeenCalled();
  });
});

describe('3 · auto mode', () => {
  it('a failure moves the card from in_review to implemented; a person’s Queue again re-dispatches once', async () => {
    const s = await makeScenario('auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('in_review');
    await adminDb.githubPullRequest.update({
      where: { id: (await prRow(21)).id },
      data: { mergeAuthority: 'auto_mode', mergeOutcomeRef: 'queue:MQE_21' },
    });

    await eject('web', 21, 'sha-auto');
    expect(await statusOf(item.id)).toBe('implemented');
    sent.length = 0;

    const pr = await prRow(21);
    const exit = (await exitsOf(21))[0]!;
    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: pr.id },
        s.ctx,
      ),
    ).resolves.toMatchObject({ status: 'in_review' });
    expect(await statusOf(item.id)).toBe('in_review');
    const keys = sent
      .filter((e) => e.name === 'pull-request/auto-merge.requested')
      .map((e) => e.data['idempotencyKey']);
    expect(keys).toEqual([`${pr.id}:sha-auto:requeue:${exit.id}`]);

    await expect(
      pullRequestMergeService.requeueAutoMember(
        { workItemId: item.id, pullRequestId: pr.id },
        s.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyRequeuedError);
    expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toHaveLength(1);
    expect(await awaiting(item.id)).toEqual([]);
  });
});

describe('4 · the dispositions, over the WHOLE reason table', () => {
  // Derived from the constant the handler reads — never re-typed.
  const reasons = Object.keys(QUEUE_EXIT_REASONS) as Array<keyof typeof QUEUE_EXIT_REASONS>;

  it('covers every reason in the map, plus one nobody has mapped', () => {
    expect(reasons.length).toBeGreaterThanOrEqual(12);
    expect(classifyQueueExit('SOMETHING_NEW')).toEqual({
      disposition: 'neutral',
      recognised: false,
    });
  });

  it.each([...reasons, 'SOMETHING_NEW'])('%s', async (reason) => {
    const disposition = classifyQueueExit(reason).disposition;
    const { item } = await approvedIntoTheQueue(`reason-${reason.toLowerCase()}@example.com`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await eject('web', 7, 'sha-web', reason);

    expect(result).toMatchObject({ disposition });
    if (disposition === 'landed') {
      expect(result).toMatchObject({ outcome: 'landed' });
      expect(await exitsOf(7)).toEqual([]);
      expect(await queueRef(7)).toBe('queue:MQE_7');
      expect(await statusOf(item.id)).toBe('approved');
    } else {
      expect(await exitsOf(7)).toEqual([
        expect.objectContaining({ rawReason: reason, disposition }),
      ]);
      expect(await queueRef(7)).toBeNull();
      expect(await statusOf(item.id)).toBe(disposition === 'failure' ? 'implemented' : 'approved');
    }
    // The other member is never touched.
    expect(await queueRef(12)).toBe('queue:MQE_12');
    expect(warn).toHaveBeenCalledTimes(reason === 'SOMETHING_NEW' ? 1 : 0);
  });
});

describe('5 · redelivery and order', () => {
  it('the same GUID twice writes one row', async () => {
    const { item } = await approvedIntoTheQueue('redeliver@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', 'CI_FAILURE', id);
    expect(await eject('web', 7, 'sha-web', 'CI_FAILURE', id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('implemented');
  });

  // NEUTRAL exits from here: Queue again survives only for them (MOTIR-5802).
  it('an OLD exit redelivered after Queue again changes nothing, and the queue ref is kept', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('old-exit@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', 'MANUAL', id);
    enqueueAll();
    await queueAgain(s, approved.id, 7);
    expect(await statusOf(item.id)).toBe('approved');

    expect(await eject('web', 7, 'sha-web', 'MANUAL', id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await statusOf(item.id)).toBe('approved');
    expect(await queueRef(7)).toBe('queue:MQE_7');
    expect(await exitsOf(7)).toHaveLength(1);
  });

  it('a second GENUINE exit at the same head after Queue again is a new row, offered again', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('second-exit@example.com');
    await eject('web', 7, 'sha-web', 'MANUAL');
    enqueueAll();
    await queueAgain(s, approved.id, 7);

    expect(await eject('web', 7, 'sha-web', 'MANUAL')).toMatchObject({ outcome: 'recorded' });
    expect(await exitsOf(7)).toHaveLength(2);
    expect((await exitsOf(7))[1]!.requeuedAt).toBeNull();
    expect(await statusOf(item.id)).toBe('approved');
    expect(await queueRef(7)).toBeNull();

    // …and the new exit is offered again, on the same approval.
    enqueueAll();
    expect(await queueAgain(s, approved.id, 7)).toMatchObject({ outcome: 'enqueued' });
    expect(await statusOf(item.id)).toBe('approved');
  });
});

describe('6 · the failing check', () => {
  it('names the latest exit and leaves the pull request’s own CI rows and verdict untouched', async () => {
    const { item } = await approvedIntoTheQueue('check@example.com');
    const group = 'abcabcabcabcabcabcabcabcabcabcabcabcabca';
    const requested = captured('merge-group-checks-requested');
    const mg = requested['merge_group'] as Record<string, unknown>;
    await githubWebhookService.handleEvent('merge_group', {
      ...requested,
      installation: INSTALLATION,
      repository: repository('web'),
      merge_group: {
        ...mg,
        head_sha: group,
        head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${mg['base_sha'] as string}`,
      },
    });
    const before = await prRow(7);
    const rowsBefore = before.checkRuns.length;
    const verdictBefore = derivePrCiState(before.checkRuns);
    expect(verdictBefore).toBe('passing');

    const failed = captured('check-run-failed-merge-group');
    await githubWebhookService.handleEvent('check_run', {
      ...failed,
      installation: INSTALLATION,
      repository: repository('web'),
      check_run: { ...(failed['check_run'] as Record<string, unknown>), head_sha: group },
    });
    await eject('web', 7, 'sha-web');

    expect((await exitsOf(7))[0]).toMatchObject({
      failingCheckName: 'Vitest (7/12)',
      failingCheckUrl: expect.stringContaining('/job/103732354674'),
    });
    const after = await prRow(7);
    expect(after.checkRuns).toHaveLength(rowsBefore);
    expect(derivePrCiState(after.checkRuns)).toBe(verdictBefore);
    expect(await adminDb.githubCheckRun.count({ where: { commitSha: group } })).toBe(0);
    expect(await statusOf(item.id)).toBe('implemented');
  });
});

describe('7 · the architecture', () => {
  const roots = ['lib', 'app', 'components', 'packages'];
  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* sources(path);
      else if (/\.(ts|tsx)$/.test(name)) yield path;
    }
  }
  const all = roots.flatMap((root) => [...sources(join(process.cwd(), root))]);
  const rel = (path: string) => path.slice(process.cwd().length + 1);

  it('only lib/services imports the queue-exit and queue-attempt repositories', () => {
    const offenders = all
      .filter((path) =>
        /githubPullRequestQueueExitRepository|githubMergeQueueAttemptRepository/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map(rel)
      .filter(
        (path) =>
          !path.startsWith('lib/services/') &&
          path !== 'lib/repositories/githubPullRequestQueueExitRepository.ts' &&
          path !== 'lib/repositories/githubMergeQueueAttemptRepository.ts',
      );
    expect(offenders).toEqual([]);
  });

  it('the ejection arm writes status only through applyStatusTransition, and the check arm writes none', () => {
    const code = (file: string) =>
      readFileSync(join(process.cwd(), file), 'utf8').replace(/\/\/.*$/gm, '');
    const exitArm = code('lib/services/mergeQueueExitService.ts');
    expect(exitArm).toMatch(/\bapplyStatusTransition\(/);
    expect(exitArm).not.toMatch(/\bupdateStatus\(|workItemRepository\.update\(/);
    const checkArm = code('lib/services/mergeQueueCheckService.ts');
    expect(checkArm).not.toMatch(
      /applyStatusTransition\(|updateStatus\(|workItemRepository|githubCheckRun/,
    );
  });

  it('the Queue again path gets its status write from the ejection service, not its own', () => {
    const merge = readFileSync(
      join(process.cwd(), 'lib/services/pullRequestMergeService.ts'),
      'utf8',
    );
    expect(merge).not.toMatch(/\bapplyStatusTransition\(|\bupdateStatus\(/);
    expect(merge).toMatch(/queueExitCardMoves\.returnCard\(/);
  });
});

describe('9 · the doors a person presses', () => {
  const post = (id: string, pullRequestId: string, body: string) =>
    queueAgainRoute(
      new Request(
        `http://localhost/api/work-items/${id}/pull-requests/${pullRequestId}/queue-again`,
        {
          method: 'POST',
          body,
        },
      ),
      { params: Promise.resolve({ id, pullRequestId }) },
    );

  it('the route re-queues on the decided approval, and answers a second press with 409', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('route-manual@example.com');
    await eject('web', 7, 'sha-web', 'MANUAL');
    doors.ctx = s.ctx;
    const prId = (await prRow(7)).id;
    enqueueAll();

    const first = await post(item.id, prId, JSON.stringify({ approvalGateId: approved.id }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ member: { outcome: 'enqueued' } });
    expect(await statusOf(item.id)).toBe('approved');

    const second = await post(item.id, prId, JSON.stringify({ approvalGateId: approved.id }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      member: { outcome: 'refused', refusal: { tag: 'MERGE_ALREADY_REQUEUED' } },
    });
  });

  it('the route answers a manual FAILURE exit with MERGE_REQUEUE_NEEDS_APPROVAL, and re-queues nothing (MOTIR-5802)', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('route-failure@example.com');
    await eject('web', 7, 'sha-web');
    doors.ctx = s.ctx;
    const prId = (await prRow(7)).id;
    const host = enqueueAll();
    host.mockClear();

    const res = await post(item.id, prId, JSON.stringify({ approvalGateId: approved.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      member: { outcome: 'refused', refusal: { tag: 'MERGE_REQUEUE_NEEDS_APPROVAL' } },
    });
    expect(host).not.toHaveBeenCalled();
    expect((await exitsOf(7))[0]!.requeuedAt).toBeNull();
  });

  it('the route’s auto door re-dispatches, and maps each refusal to its status', async () => {
    const s = await makeScenario('route-auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    await eject('web', 21, 'sha-auto');
    doors.ctx = s.ctx;
    const prId = (await prRow(21)).id;

    expect((await post(item.id, prId, 'not json')).status).toBe(400);
    expect((await post('no-such-card', prId, '')).status).toBe(404);
    const noExit = await post(item.id, 'no-such-pr', '{}');
    expect(noExit.status).toBe(409);
    expect(await noExit.json()).toMatchObject({ reason: 'not_delivered' });

    const ok = await post(item.id, prId, '');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ pullRequestId: prId, status: 'in_review' });

    const again = await post(item.id, prId, '{}');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'MERGE_ALREADY_REQUEUED' });
  });

  it('the auto action answers a status, and a refusal in the frame’s vocabulary', async () => {
    const s = await makeScenario('action-auto@example.com', 'auto');
    const item = await card(s, [['web', 21]]);
    await green('web', 21, 'sha-auto');
    await eject('web', 21, 'sha-auto');
    doors.ctx = s.ctx;
    const pullRequestId = (await prRow(21)).id;
    const press = () =>
      queueAgainAutoAction({ workItemId: item.id, pullRequestId, identifier: item.identifier });

    expect(await press()).toEqual({ ok: true, status: 'in_review' });
    expect(await press()).toEqual({
      ok: false,
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    // A stale page pressing where the button is never offered.
    expect(
      await queueAgainAutoAction({
        workItemId: item.id,
        pullRequestId: 'no-such-pr',
        identifier: item.identifier,
      }),
    ).toEqual({ ok: false, refusal: { tag: 'UNEXPECTED' } });
  });
});

describe('10 · the ejection arm’s edges, through the real handler', () => {
  it('refuses a delivery with no GUID or no installation, and names what it could not find', async () => {
    await approvedIntoTheQueue('edges@example.com');
    const body = dequeuedBody('web', 7, 'sha-web', 'CI_FAILURE');
    expect(await githubWebhookService.handleEvent('pull_request', body, null)).toMatchObject({
      outcome: 'malformed',
    });
    const { installation: _dropped, ...noInstallation } = body;
    expect(
      await githubWebhookService.handleEvent('pull_request', noInstallation, nextGuid()),
    ).toMatchObject({ outcome: 'unknown_installation' });
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, installation: { id: 'not-ours' } },
        nextGuid(),
      ),
    ).toMatchObject({ outcome: 'unknown_installation' });
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, repository: { id: 9999 } },
        nextGuid(),
      ),
    ).toMatchObject({ outcome: 'unknown_repo' });
    expect(await eject('web', 999, 'sha-x')).toMatchObject({ outcome: 'unknown_pull_request' });
    expect(await exitsOf(7)).toEqual([]);
  });

  it('a removal that states no reason is a neutral exit recorded with an empty reason; a body with no head is malformed', async () => {
    const { item } = await approvedIntoTheQueue('no-reason@example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = dequeuedBody('web', 7, 'sha-web', 'CI_FAILURE');
    const { reason: _none, ...noReason } = body;
    expect(
      await githubWebhookService.handleEvent('pull_request', noReason, nextGuid()),
    ).toMatchObject({ outcome: 'recorded', disposition: 'neutral', rawReason: null });
    expect(await exitsOf(7)).toEqual([expect.objectContaining({ rawReason: '' })]);
    expect(await statusOf(item.id)).toBe('approved');
    expect(warn).toHaveBeenCalledTimes(1);

    const pr = structuredClone(body.pull_request) as Record<string, unknown>;
    pr['head'] = {};
    expect(
      await githubWebhookService.handleEvent(
        'pull_request',
        { ...body, pull_request: pr },
        nextGuid(),
      ),
    ).toEqual({ event: 'pull_request', outcome: 'malformed' });
  });

  it('an auto card with no pull request has no standing exit', async () => {
    const s = await makeScenario('auto-empty@example.com', 'auto');
    const item = await card(s, []);
    expect(
      await pullRequestMergeService.listStandingQueueExits({ workItemId: item.id }, s.ctx),
    ).toEqual([]);
  });

  it('a workspace with no owner records the exit and moves no card, naming each one', async () => {
    const { s, item } = await approvedIntoTheQueue('ownerless@example.com');
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: s.workspace.id },
      data: { role: 'member' },
    });

    expect(await eject('web', 7, 'sha-web')).toMatchObject({
      outcome: 'recorded',
      moved: [],
      skipped: [{ key: item.identifier, status: 'approved', reason: 'no_actor' }],
      clearedQueuedOutcome: true,
    });
    expect(await exitsOf(7)).toHaveLength(1);
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('a delivery that loses the unique-index race reads as a duplicate; any other write fault is thrown', async () => {
    await approvedIntoTheQueue('race@example.com');
    const id = nextGuid();
    await eject('web', 7, 'sha-web', 'CI_FAILURE', id);
    // The redelivery check misses (a concurrent copy), so the index is the backstop.
    vi.spyOn(githubPullRequestQueueExitRepository, 'findByDeliveryId').mockResolvedValueOnce(null);
    expect(await eject('web', 7, 'sha-web', 'CI_FAILURE', id)).toMatchObject({
      outcome: 'duplicate',
    });
    expect(await exitsOf(7)).toHaveLength(1);

    vi.spyOn(githubPullRequestQueueExitRepository, 'create').mockRejectedValueOnce(
      new Error('the disk is full'),
    );
    await expect(eject('web', 7, 'sha-web')).rejects.toThrow('the disk is full');
  });

  // REPLACES "a workflow that cannot take the card back leaves it" (MOTIR-5634): Queue
  // again no longer moves a card at all (MOTIR-5802), so a workflow without
  // `implemented → approved` changes nothing about it.
  it('Queue again on a neutral exit re-queues and writes no status, with or without `implemented → approved`', async () => {
    const { s, item, approved } = await approvedIntoTheQueue('no-edge@example.com');
    await eject('web', 7, 'sha-web', 'MANUAL');
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId: s.project.id } });
    const idOf = (key: string) => statuses.find((row) => row.key === key)!.id;
    await adminDb.workflowTransition.deleteMany({
      where: {
        projectId: s.project.id,
        fromStatusId: idOf('implemented'),
        toStatusId: idOf('approved'),
      },
    });
    enqueueAll();
    sent.length = 0;

    expect(await queueAgain(s, approved.id, 7)).toMatchObject({ outcome: 'enqueued' });
    expect(await queueRef(7)).toBe('queue:MQE_7');
    expect(await statusOf(item.id)).toBe('approved');
    expect(sent.filter((e) => e.name === 'work-item/transitioned')).toEqual([]);
  });
});

describe('8 · no per-pull-request gate', () => {
  it('is asserted after every scenario above (afterEach), and the refusal type is the shipped one', () => {
    expect(new QueueAgainRefusedError('no_exit', 'x')).toBeInstanceOf(Error);
  });
});
