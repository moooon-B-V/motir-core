import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import * as mergeService from '@/lib/services/pullRequestMergeService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// THE STORY GATE — Story MOTIR-4910 · MOTIR-5600.
//
// The assembled feature, end to end, on a REAL Postgres through the REAL webhook door:
// a signed `pull_request_review` delivery → a review row → the set verdict → the ONE decide
// door → the card's status → the MERGE. No service is mocked; the only thing stubbed is the
// host itself, which is the one thing that leaves the process.
//
// ⚠️ THE GATE IS RAISED BY A REAL CI-GREEN PROMOTION, never seeded. A seeded `approval_gate`
// row would assert the evaluator against a fixture of the thing under test — the promotion,
// the delivery-set version and the raise are exactly the parts a seam test exists to cover.

const KIND = 'pull_request_approval' as const;
const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-5600';
const REPO_PROVIDER_ID = '7700';
const github = getGitProvider('github') as Required<GitProvider>;

let deliverySeq = 0;
let reviewSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  _resetInstallationTokenCache();
  vi.restoreAllMocks();
  // The permission read — the one host call the RECORDING path makes.
  vi.spyOn(github, 'getRepositoryPermission').mockResolvedValue('write');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

async function scenario(email: string) {
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
  // `manual` — in `auto` no gate is raised at all, so there is no synced decision to make.
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
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
  return { user, workspace, project, ctx: { userId: user.id, workspaceId: workspace.id } };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function openLinked(identifier: string, number: number) {
  const headRef = `parent/${identifier}-work`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `Change #${number}`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** CI goes green on one pull request — what RAISES the gate, through the real promotion. */
const ci = (number: number, headSha: string) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

/** A card delivering #11 and #12. `green` drives the real CI promotion that raises the gate. */
async function card(s: Scenario, opts: { green?: boolean } = {}) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: 'Throttle the public API' },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await openLinked(item.identifier, 11);
  await openLinked(item.identifier, 12);
  if (opts.green !== false) {
    await ci(11, 'sha-a');
    await ci(12, 'sha-b');
  }
  return item;
}

function reviewBody(o: {
  number: number;
  commitSha: string;
  state?: 'approved' | 'changes_requested';
  login?: string;
  userId?: number;
  reviewId?: number;
}): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/pull-request-review');
  const base = JSON.parse(readFileSync(join(file, 'submitted-approved.json'), 'utf8')) as {
    payload: Record<string, unknown>;
  };
  const body = structuredClone(base.payload);
  reviewSeq += 1;
  return {
    ...body,
    review: {
      ...(body['review'] as Record<string, unknown>),
      id: o.reviewId ?? 900000 + reviewSeq,
      state: o.state ?? 'approved',
      commit_id: o.commitSha,
      user: { login: o.login ?? 'ada-l', id: o.userId ?? 4242, type: 'User' },
    },
    pull_request: {
      ...(body['pull_request'] as Record<string, unknown>),
      number: o.number,
      head: { ref: 'parent/ACME-1-work', sha: o.commitSha },
    },
    installation: { id: INSTALLATION_ID },
    repository: {
      id: Number(REPO_PROVIDER_ID),
      name: 'acme',
      full_name: 'moooon/acme',
      owner: { login: 'moooon', id: 55, type: 'Organization' },
    },
  };
}

const review = (o: Parameters<typeof reviewBody>[0]) => {
  deliverySeq += 1;
  return githubWebhookService.handleEvent(
    'pull_request_review',
    reviewBody(o),
    `gate-d-${deliverySeq}`,
  );
};

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const gateOf = async (workItemId: string) =>
  adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId, kind: KIND },
    orderBy: { createdAt: 'desc' },
  });
const prRow = (number: number) => adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });

/** Answer the host per pull-request number. */
function stubMerge(answers: Record<number, MergeChangeRequestResult>) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answers[args.number]!);
}

/** What a settled promise REJECTED with, as text — the message an assertion prints
 *  when it fails. `String(reason)` keeps a Prisma error's code and meta, which is
 *  the part that names the defect class. */
function reasonOf(settled: PromiseSettledResult<unknown>): string {
  return settled.status === 'rejected' ? String(settled.reason) : '';
}

describe('§2 seam — delivery → row → verdict → door → status → MERGE (MOTIR-5600)', () => {
  it('one approval leaves the gate awaiting; the second decides it AND merges both members', async () => {
    const s = await scenario('gate-seam@example.com');
    const item = await card(s);
    // The gate exists because CI went green through the real promotion, not because a row
    // was seeded.
    expect(await statusOf(item.id)).toBe('in_review');
    const raised = await gateOf(item.id);
    expect(raised.state).toBe('awaiting');

    const shared = vi.spyOn(mergeService, 'mergeApprovedSetMembers');
    stubMerge({
      11: { outcome: 'merged', commitSha: 'merge-11' },
      12: { outcome: 'enqueued', entryId: 'MQE_12' },
    });

    const first = await review({ number: 11, commitSha: 'sha-a' });
    expect(first).toMatchObject({ event: 'pull_request_review', outcome: 'pending' });
    expect((await gateOf(item.id)).state).toBe('awaiting');
    expect(shared).not.toHaveBeenCalled();

    const second = await review({
      number: 12,
      commitSha: 'sha-b',
      login: 'grace-h',
      userId: 9999,
    });
    expect(second).toMatchObject({ outcome: 'decided_approved' });

    const gate = await gateOf(item.id);
    expect(gate.state).toBe('approved');
    expect(gate.decisionSource).toBe('github');
    expect(gate.decidedUnderAuthority).toBe('github_review');
    expect(gate.decidedByLabel).toBe('@grace-h');
    expect(await statusOf(item.id)).toBe('approved');

    // ⚠️ THE SAME FUNCTION A PRESS CALLS — a second merge implementation fails this.
    expect(shared).toHaveBeenCalledTimes(1);
    expect(await prRow(11)).toMatchObject({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-11',
    });
    expect(await prRow(12)).toMatchObject({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'queue:MQE_12',
    });
  });

  it('a REFUSED member leaves the gate approved, and the other member still merges', async () => {
    const s = await scenario('gate-refused@example.com');
    const item = await card(s);
    stubMerge({
      11: { outcome: 'merged', commitSha: 'merge-11' },
      12: { outcome: 'refused', refusal: { code: 'conflict' } },
    });

    await review({ number: 11, commitSha: 'sha-a' });
    await review({ number: 12, commitSha: 'sha-b', login: 'grace-h', userId: 9999 });

    // Neither the decision nor the card's status is rolled back by a host refusal.
    expect((await gateOf(item.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect((await prRow(11)).mergeOutcomeRef).toBe('merge-11');
    expect((await prRow(12)).mergeOutcomeRef).toBeNull();
  });

  it('approvals given BEFORE the gate existed decide it when CI turns green', async () => {
    const s = await scenario('gate-prearrival@example.com');
    const item = await card(s, { green: false });
    // The card is `implemented` with no gate: reviews are recorded whether or not one
    // exists, which is the whole of decision 8.
    expect(await statusOf(item.id)).toBe('implemented');
    stubMerge({
      11: { outcome: 'merged', commitSha: 'merge-11' },
      12: { outcome: 'merged', commitSha: 'merge-12' },
    });

    const early = await review({ number: 11, commitSha: 'sha-a' });
    expect(early).toMatchObject({ outcome: 'no_awaiting_gate' });
    await review({ number: 12, commitSha: 'sha-b', login: 'grace-h', userId: 9999 });

    // No further delivery: the promotion raises the gate and the post-raise evaluation
    // applies the reviews already recorded.
    await ci(11, 'sha-a');
    await ci(12, 'sha-b');

    expect((await gateOf(item.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect((await prRow(11)).mergeOutcomeRef).toBe('merge-11');
  });

  it('the READ agrees with the verdict, per pull request', async () => {
    const s = await scenario('gate-read@example.com');
    const item = await card(s);
    await review({ number: 11, commitSha: 'sha-a' });

    const rows = await workItemsService.listLinkedPullRequests(item.id, s.ctx);
    const byNumber = new Map(rows.map((r) => [r.number, r.githubReview]));
    // #11 was approved at its current head; #12 has no review at all. The row and the gate
    // read the same rule (`countableReviewsAtHead`), so they cannot disagree.
    expect(byNumber.get(11)).toEqual({ state: 'approved', atCurrentHead: true });
    expect(byNumber.get(12)).toBeNull();
    // ...and the gate is still awaiting, which is the same fact from the other side.
    expect((await gateOf(item.id)).state).toBe('awaiting');
  });
});

describe('§3 guards — the ones coverage cannot see (MOTIR-5600)', () => {
  it('posts NO review to GitHub at runtime, while its merge requests ARE made', async () => {
    const s = await scenario('gate-onedirectional@example.com');
    const item = await card(s);
    const merge = stubMerge({
      11: { outcome: 'merged', commitSha: 'merge-11' },
      12: { outcome: 'merged', commitSha: 'merge-12' },
    });
    // Every outbound call the sync could make, observed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await review({ number: 11, commitSha: 'sha-a' });
    await review({ number: 12, commitSha: 'sha-b', login: 'grace-h', userId: 9999 });
    expect((await gateOf(item.id)).state).toBe('approved');

    const reviewPosts = fetchSpy.mock.calls.filter(([url, init]) => {
      const href = typeof url === 'string' ? url : String(url);
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      return /\/pulls\/\d+\/reviews/.test(href) && method.toUpperCase() === 'POST';
    });
    // The absence IS the assertion (decision 9) — Motir must not write into a customer's
    // review history.
    expect(reviewPosts).toEqual([]);
    // ...and this is not vacuous: the merge really did reach the host.
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it('keeps every value-keyed map over the three enums TOTAL', async () => {
    // Enumerated from the DATABASE, not from a TypeScript union, so a member added by a
    // migration and not by a type shows up here.
    const members = async (typname: string) =>
      (
        await adminDb.$queryRawUnsafe<Array<{ enumlabel: string }>>(
          `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = $1 ORDER BY e.enumsortorder`,
          typname,
        )
      ).map((r) => r.enumlabel);

    expect(await members('github_review_state')).toEqual([
      'approved',
      'changes_requested',
      'commented',
      'dismissed',
    ]);
    expect(await members('github_repository_permission')).toEqual([
      'admin',
      'maintain',
      'write',
      'triage',
      'read',
      'none',
      'unknown',
    ]);
    expect(await members('approval_gate_authority')).toEqual([
      'assignee',
      'reporter',
      'admin',
      'github_review',
    ]);
  });

  it('survives a CONCURRENT redelivery — one row, one decision, one merge per member', async () => {
    const s = await scenario('gate-redelivery@example.com');
    const item = await card(s);
    const merge = stubMerge({
      11: { outcome: 'merged', commitSha: 'merge-11' },
      12: { outcome: 'merged', commitSha: 'merge-12' },
    });
    await review({ number: 11, commitSha: 'sha-a', reviewId: 5001 });

    // The SAME delivery twice, genuinely at once — the shape a hand redelivery produces.
    const body = reviewBody({
      number: 12,
      commitSha: 'sha-b',
      reviewId: 5002,
      login: 'grace-h',
      userId: 9999,
    });
    const [a, b] = await Promise.allSettled([
      githubWebhookService.handleEvent('pull_request_review', body, 'redeliver-a'),
      githubWebhookService.handleEvent('pull_request_review', body, 'redeliver-b'),
    ]);

    // ⚠️ REPORT THE REASON, never just the status (MOTIR-5693). This assertion
    // spent a day being re-run as a flake because `'rejected'` names no class: the
    // cause was a `25P02` raised two layers down, and it only became readable when
    // a SIBLING test happened to print its own. A rejection here now says why.
    expect(a.status, reasonOf(a)).toBe('fulfilled');
    expect(b.status, reasonOf(b)).toBe('fulfilled');
    await expect(
      adminDb.githubPullRequestReview.count({ where: { githubReviewId: '5002' } }),
    ).resolves.toBe(1);
    const decided = await adminDb.approvalGate.findMany({
      where: { workItemId: item.id, kind: KIND, state: 'approved' },
    });
    expect(decided).toHaveLength(1);
    // One merge attempt per member — not two, however many copies of the delivery arrived.
    expect(merge.mock.calls.map((c) => c[0].number).sort()).toEqual([11, 12]);
  });
});
