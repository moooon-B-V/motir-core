import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));

const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('@/lib/jobs/sendEvent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jobs/sendEvent')>()),
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    sent.push({ name, data });
  },
}));

import { db } from '@/lib/db';
import { mintInstallationToken } from '@/lib/github/appAuth';
import { pullRequestAutoMerge } from '@/lib/jobs/definitions/pullRequestAutoMerge';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';
import { linkPrByIdentifier } from '../helpers/prLink';

const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');

// THE MERGE STORY'S JOURNEY, ACROSS ITS SEAMS (Story MOTIR-4882 · MOTIR-5519, §2) — real
// Postgres and the real webhook service, CI reports, the decide ROUTE and the merge
// webhook, with GitHub stubbed only at `fetch` and the App credential at `appAuth`
// (the convention in `tests/git/providerSeam.test.ts`). Each child's units mock their
// neighbours; this is the one place the chain runs whole:
//
//   green checks raise a question → a person answers it → GitHub merges →
//   the merge webhook, and nothing else, finishes the card.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-merge-journey';
const REPO_PROVIDER_ID = '993';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

// ── the stubbed host ───────────────────────────────────────────────────────────

interface Host {
  /** The head GitHub reports for each pull request number. */
  heads: Record<number, string>;
  /** The base branch's rules — `[{ type: 'merge_queue' }]` for a queued repository. */
  rules: unknown[];
  /** The answer to `PUT /pulls/{n}/merge`. */
  merge: (n: number) => { status: number; body?: unknown; headers?: Record<string, string> };
  /** The pull request as it reads on its SECOND read (the re-read after a 405). */
  reread: (n: number) => Record<string, unknown>;
  calls: Array<{ method: string; url: string }>;
}

let host: Host;

function resetHost(): void {
  host = {
    heads: {},
    rules: [],
    merge: (n) => ({ status: 200, body: { merged: true, sha: `merge-${n}` } }),
    reread: () => ({}),
    calls: [],
  };
  const reads = new Map<number, number>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers });
      const pull = url.match(/\/repos\/moooon\/acme\/pulls\/(\d+)(\/merge)?$/);
      if (url.endsWith('/repos/moooon/acme') && method === 'GET') {
        host.calls.push({ method, url });
        return json(200, { allow_squash_merge: true });
      }
      if (url.includes('/rules/branches/')) {
        host.calls.push({ method, url });
        return json(200, host.rules);
      }
      if (url.endsWith('/graphql')) {
        host.calls.push({ method, url });
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } });
      }
      if (pull && pull[2] && method === 'PUT') {
        host.calls.push({ method, url });
        const answer = host.merge(Number(pull[1]));
        return json(answer.status, answer.body ?? {}, answer.headers);
      }
      if (pull && !pull[2]) {
        const n = Number(pull[1]);
        host.calls.push({ method, url });
        const count = (reads.get(n) ?? 0) + 1;
        reads.set(n, count);
        return json(200, {
          node_id: `PR_${n}`,
          merged: false,
          state: 'open',
          head: { sha: host.heads[n] ?? 'unknown' },
          base: { ref: 'main' },
          ...(count > 1 ? host.reread(n) : {}),
        });
      }
      // Everything else the webhook path touches — the link check, the file listing —
      // is not this journey's subject.
      return json(404, {});
    }),
  );
}

const mergeCalls = () => host.calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/graphql'));

// ── the scenario ───────────────────────────────────────────────────────────────

async function makeScenario(email: string, mode: 'auto' | 'manual') {
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
  signedIn.current = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}
type Scenario = Awaited<ReturnType<typeof makeScenario>>;

function prDelivery(action: string, number: number, headRef: string, merged = false) {
  return githubWebhookService.handleEvent('pull_request', {
    action,
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      merged_at: merged ? new Date().toISOString() : null,
      title: 'A change',
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

async function cardWithPrs(s: Scenario, numbers: number[]) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'The journey' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  for (const number of numbers) {
    const headRef = `subtask/${item.identifier}-${number}`;
    await linkPrByIdentifier({
      identifier: item.identifier,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef,
    });
    await prDelivery('opened', number, headRef);
  }
  return item;
}

/** CI reports a verdict for one pull request at one head — and GitHub now reports it. */
async function ci(conclusion: string | null, headSha: string, number: number) {
  host.heads[number] = headSha;
  return githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });
}

async function decide(gateId: string, decision = 'approve') {
  const res = await decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
const gateFor = async (workItemId: string, number: number, state = 'awaiting') => {
  const pr = await prRow(number);
  return adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, subjectId: pr.id, kind: 'pull_request_merge', state: state as never },
  });
};

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  resetHost();
  sent.length = 0;
  signedIn.current = null;
  vi.mocked(mintInstallationToken).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('journey 1 — manual, imported repository, two pull requests: approve → merge → webhook → Done', () => {
  it('green raises two gates; approving merges through the ROUTE; only the merge webhook finishes the card', async () => {
    const s = await makeScenario('journey-1@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);

    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    expect(await statusOf(item.id)).toBe('in_review');
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: item.id, kind: 'pull_request_merge', state: 'awaiting' },
      }),
    ).toBe(2);

    for (const number of [11, 12]) {
      const gate = await gateFor(item.id, number);
      const res = await decide(gate.id);
      expect(res.status).toBe(200);
      expect((await gateRow(gate.id)).state).toBe('approved');
      expect(await prRow(number)).toMatchObject({
        mergeAuthority: 'gate',
        mergeOutcomeRef: `merge-${number}`,
      });
    }

    // GUARD (b) — ONE STATUS WRITER. Both merges happened and were recorded; the
    // webhook has not been delivered, so the card has not moved.
    expect(await statusOf(item.id)).toBe('in_review');
    expect(mergeCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);

    await prDelivery('closed', 11, `subtask/${item.identifier}-11`, true);
    expect(await statusOf(item.id)).toBe('in_review'); // its other pull request is still open
    await prDelivery('closed', 12, `subtask/${item.identifier}-12`, true);
    expect(await statusOf(item.id)).toBe('done');

    await expectEveryMergeGateOutcomeNull();
  });
});

describe('journey 2 — the App is chosen by the repository PROVENANCE', () => {
  it('an imported repository mints through user-facing; the same approval on a hosted one through provisioning', async () => {
    const s = await makeScenario('journey-2@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);

    await decide((await gateFor(item.id, 11)).id);
    expect(mintInstallationToken).toHaveBeenLastCalledWith(INSTALLATION_ID, 'user-facing');

    // `moooon` becomes the organisation Motir provisions into — a HOSTED repository.
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon');
    await decide((await gateFor(item.id, 12)).id);
    expect(mintInstallationToken).toHaveBeenLastCalledWith(INSTALLATION_ID, 'provisioning');
  });
});

describe('journey 3 — a base branch with a merge QUEUE is enqueued, and the card waits for the queue', () => {
  it('enqueuePullRequest, no merge call, queue:<id> on the pull request, the card still in review', async () => {
    const s = await makeScenario('journey-3@example.com', 'manual');
    const item = await cardWithPrs(s, [11]);
    host.rules = [{ type: 'merge_queue' }];
    await ci('success', 'sha-a', 11);

    const gate = await gateFor(item.id, 11);
    expect((await decide(gate.id)).status).toBe(200);

    expect(mergeCalls().map((c) => c.method)).toEqual(['POST']);
    expect((await prRow(11)).mergeOutcomeRef).toBe('queue:MQE_1');
    expect(await statusOf(item.id)).toBe('in_review');
    await expectEveryMergeGateOutcomeNull();
  });
});

describe('journey 4 — NOT green raises nothing and merges nothing, in either mode', () => {
  it.each(['manual', 'auto'] as const)(
    '%s: one red pull request — no gate, no job, no host call',
    async (mode) => {
      const s = await makeScenario(`journey-4-${mode}@example.com`, mode);
      const item = await cardWithPrs(s, [11, 12]);
      await ci('success', 'sha-a', 11);
      await ci('failure', 'sha-b', 12);

      expect(await statusOf(item.id)).toBe('implemented');
      expect(await adminDb.approvalGate.count({ where: { workItemId: item.id } })).toBe(0);
      expect(sent.filter((e) => e.name === 'pull-request/auto-merge.requested')).toEqual([]);
      expect(mergeCalls()).toEqual([]);
    },
  );
});

describe('journey 5 — every merge refusal through the ROUTE leaves the gate awaiting', () => {
  const MATRIX = [
    {
      code: 'MERGE_CHECKS_NOT_GREEN',
      status: 409,
      merge: { status: 405, body: { message: 'Required status check "ci" is expected.' } },
      reread: { mergeable_state: 'blocked' },
    },
    {
      code: 'MERGE_CONFLICT',
      status: 409,
      merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
      reread: { mergeable_state: 'dirty' },
    },
    {
      code: 'MERGE_BRANCH_PROTECTED',
      status: 409,
      merge: { status: 405, body: { message: 'At least 1 approving review is required.' } },
      reread: { mergeable_state: 'blocked' },
    },
    {
      code: 'MERGE_ALREADY_MERGED',
      status: 409,
      merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
      reread: { merged: true, state: 'closed' },
    },
    {
      code: 'MERGE_APP_PERMISSION_MISSING',
      status: 424,
      merge: { status: 403, headers: { 'x-accepted-github-permissions': 'contents=write' } },
      reread: {},
    },
  ];

  it('the five refusals, then a moved head that supersedes with no host call', async () => {
    const s = await makeScenario('journey-5@example.com', 'manual');
    const item = await cardWithPrs(s, [11]);
    await ci('success', 'sha-a', 11);
    const gate = await gateFor(item.id, 11);

    for (const row of MATRIX) {
      resetHost();
      host.heads[11] = 'sha-a';
      host.merge = () => row.merge;
      host.reread = () => row.reread;

      const res = await decide(gate.id);
      expect(res, row.code).toMatchObject({ status: row.status, body: { code: row.code } });
      expect((await gateRow(gate.id)).state, row.code).toBe('awaiting');
      expect((await prRow(11)).mergeAuthority, row.code).toBeNull();
    }

    // A head that moved after the gate was raised — recorded straight onto the pull
    // request, so it is the entry point's own check that finds it.
    resetHost();
    await adminDb.githubCheckRun.create({
      data: {
        pullRequestId: (await prRow(11)).id,
        commitSha: 'sha-moved',
        checkName: 'ci',
        conclusion: 'pending',
      },
    });
    const res = await decide(gate.id);
    expect(res).toMatchObject({ status: 409, body: { code: 'APPROVAL_GATE_SUPERSEDED' } });
    expect(host.calls).toEqual([]);
    await expectEveryMergeGateOutcomeNull();
  });
});

describe('journey 6 — AUTO merges both pull requests after promotion, and writes no gate', () => {
  it('two jobs, two auto_mode records, zero approval_gate rows', async () => {
    const s = await makeScenario('journey-6@example.com', 'auto');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    expect(await statusOf(item.id)).toBe('in_review');

    const jobs = sent.filter((e) => e.name === 'pull-request/auto-merge.requested');
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const outcome = await new JobTestEngine({
        function: pullRequestAutoMerge,
        events: [{ name: job.name, data: job.data }],
      }).execute();
      expect(outcome.error).toBeUndefined();
    }

    expect(
      [await prRow(11), await prRow(12)].map((r) => [r.mergeAuthority, r.mergeOutcomeRef]),
    ).toEqual([
      ['auto_mode', 'merge-11'],
      ['auto_mode', 'merge-12'],
    ]);
    expect(await adminDb.approvalGate.count()).toBe(0);
  });
});

describe('journey 7 — a push withdraws only its own gate, and the next green raises a fresh one', () => {
  it('superseded on the new head, re-raised when it is green, the other gate untouched', async () => {
    const s = await makeScenario('journey-7@example.com', 'manual');
    const item = await cardWithPrs(s, [11, 12]);
    await ci('success', 'sha-a', 11);
    await ci('success', 'sha-b', 12);
    const twelve = await gateFor(item.id, 12);

    await ci(null, 'sha-a2', 11);
    expect((await gateFor(item.id, 11, 'superseded')).subjectVersion).toBe('moooon/acme#11@sha-a');

    await ci('success', 'sha-a2', 11);
    expect((await gateFor(item.id, 11)).subjectVersion).toBe('moooon/acme#11@sha-a2');
    expect((await gateFor(item.id, 12)).id).toBe(twelve.id);
  });
});

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

/**
 * GUARD (c) — `outcomeRef` KEEPS ITS MEANING. The item page applies a gate's outcome as a
 * STATUS KEY, so a merge gate is never decided with one; the merge's outcome lives on the
 * pull request. Asserted after journeys 1, 3 and 5.
 */
async function expectEveryMergeGateOutcomeNull(): Promise<void> {
  const decided = await adminDb.approvalGate.findMany({
    where: { kind: 'pull_request_merge', state: { in: ['approved', 'changes_requested'] } },
  });
  for (const gate of decided) expect(gate.outcomeRef, gate.id).toBeNull();
}
