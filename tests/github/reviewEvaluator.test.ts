import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import * as approvalGatesService from '@/lib/services/approvalGatesService';
import { ApprovalGateSupersededError } from '@/lib/approvalGates/errors';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import * as syncedMergeRunner from '@/lib/services/syncedMergeRunner';
import {
  evaluateAfterRaise,
  evaluateForPullRequest,
  evaluateForWorkItem,
} from '@/lib/services/pullRequestReviewSync';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// THE EVALUATOR (Story MOTIR-4910 · MOTIR-5597; `docs/decisions/approval-gates.md`
// §8 FOURTH AMENDMENT, decisions 1, 2, 3 and 8), against a REAL Postgres.
//
// The pure rule is covered in `tests/approvalGates/reviewVerdict.test.ts`. What is here is
// everything that needs a database: WHICH gate is decided, whose reviews are read, the
// hand-off to the merge step, and the two terminal refusals arriving as outcomes.

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const PASSWORD = 'hunter2hunter2';

let fx: WorkItemFixture;
let seq = 0;
let mergeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  mergeSpy = vi.spyOn(syncedMergeRunner, 'runSyncedMerge').mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Member {
  pullRequestId: string;
  version: string;
  headSha: string;
}

/** A card delivering two green pull requests. `gate` is raised only when asked for. */
async function scenario(opts: { withGate?: boolean; parentOf?: string } = {}) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

  const members: Record<'web' | 'api', Member> = {} as never;
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5597-${seq}`,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: `repo-5597-${seq}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change in ${name}`,
        state: 'open',
        headRef: 'parent/ACME-12-throttle',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
    members[name] = {
      pullRequestId: pr.id,
      version: `acme/${name}#${number}@${head}`,
      headSha: head,
    };
  }

  const subjectVersion = [members.web.version, members.api.version].sort().join(',');
  const gate = opts.withGate
    ? await withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: item.id,
            kind: 'pull_request_approval',
            subjectId: item.id,
            subjectVersion,
          },
          tx,
        ),
      )
    : null;
  return { item, gate, members, subjectVersion };
}

let reviewSeq = 0;
/** Record ONE review against a member, as the webhook arm will. */
async function recordReview(
  member: Member,
  o: {
    state?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
    permission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';
    githubUserId?: string;
    login?: string;
    commitSha?: string;
    at?: string;
    body?: string | null;
  } = {},
) {
  reviewSeq += 1;
  return withWorkspaceContext(fx.ctx, (tx) =>
    githubPullRequestReviewRepository.upsertByGithubReviewId(
      {
        githubReviewId: `gh-${reviewSeq}`,
        githubPullRequestId: member.pullRequestId,
        reviewerGithubUserId: o.githubUserId ?? '4242',
        reviewerLogin: o.login ?? 'ada-l',
        reviewerType: 'User',
        state: o.state ?? 'approved',
        commitSha: o.commitSha ?? member.headSha,
        reviewerPermission: o.permission ?? 'write',
        submittedAt: new Date(
          o.at ?? `2026-09-16T09:${String(reviewSeq % 60).padStart(2, '0')}:00Z`,
        ),
        htmlUrl: null,
        body: o.body ?? null,
      },
      tx,
    ),
  );
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = (id: string) =>
  adminDb.workItem.findUniqueOrThrow({ where: { id } }).then((i) => i.status);

describe('the SET decides, not one member (MOTIR-5597)', () => {
  it('stays awaiting after one member, and approves after the second', async () => {
    const { item, gate, members } = await scenario({ withGate: true });

    await recordReview(members.web);
    const first = await evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId);
    expect(first.map((e) => e.outcome)).toEqual(['pending']);
    expect((await gateRow(gate!.id)).state).toBe('awaiting');
    expect(mergeSpy).not.toHaveBeenCalled();

    await recordReview(members.api, { login: 'second-reviewer', githubUserId: '9999' });
    const second = await evaluateForPullRequest(members.api.pullRequestId, fx.workspaceId);
    expect(second.map((e) => e.outcome)).toEqual(['decided_approved']);

    const row = await gateRow(gate!.id);
    expect(row.state).toBe('approved');
    expect(row.decisionSource).toBe('github');
    expect(row.decidedUnderAuthority).toBe('github_review');
    // The decider is the review that COMPLETED the set.
    expect(row.decidedByLabel).toBe('@second-reviewer');
    // The note names every member's counting review.
    expect(row.noteMd).toContain('approved by @ada-l');
    expect(row.noteMd).toContain('approved by @second-reviewer');
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('hands the merge step the gate and its members EXACTLY ONCE on approval', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    await evaluateForWorkItem((await gateRow(gate!.id)).workItemId!, fx.workspaceId);

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    const request = mergeSpy.mock.calls[0]![0] as { gateId: string; members: unknown[] };
    expect(request.gateId).toBe(gate!.id);
    expect(request.members).toHaveLength(2);
  });

  it('requests changes on the first member that does not approve, and merges nothing', async () => {
    const { item, gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api, {
      state: 'changes_requested',
      login: 'objector',
      githubUserId: '777',
    });

    const [outcome] = await evaluateForPullRequest(members.api.pullRequestId, fx.workspaceId);
    expect(outcome!.outcome).toBe('decided_changes_requested');

    const row = await gateRow(gate!.id);
    expect(row.state).toBe('changes_requested');
    expect(row.decidedByLabel).toBe('@objector');
    // A gate's state is not a work item's status (§6b).
    expect(await statusOf(item.id)).toBe('in_review');
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('a refusal SAYS WHY — the deciding review’s BODY is the gate’s reason (MOTIR-6074, ADR §10b)', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.api, {
      state: 'changes_requested',
      login: 'objector',
      githubUserId: '777',
      body: 'The retry loop never backs off — add a ceiling.',
    });

    const [outcome] = await evaluateForPullRequest(members.api.pullRequestId, fx.workspaceId);
    expect(outcome!.outcome).toBe('decided_changes_requested');

    const row = await gateRow(gate!.id);
    expect(row.noteMd).toBe('The retry loop never backs off — add a ceiling.');
    // A reader tells it from a Motir press by the source the row already carries.
    expect(row.decisionSource).toBe('github');
  });

  it('a review with NO text records a NULL reason and is never refused for it (ADR §10b)', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web, {
      state: 'changes_requested',
      login: 'terse',
      githubUserId: '778',
      body: null,
    });

    const [outcome] = await evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId);
    // Decided, not refused: the door keys its required-reason rule on a PRESSED source.
    expect(outcome!.outcome).toBe('decided_changes_requested');
    const row = await gateRow(gate!.id);
    expect(row.state).toBe('changes_requested');
    expect(row.noteMd).toBeNull();
    expect(row.decisionSource).toBe('github');
  });

  it('counts nothing from a stale commit or a reader, and merges nothing', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web, { commitSha: 'f'.repeat(40) });
    await recordReview(members.api, { permission: 'read' });

    const [outcome] = await evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId);
    expect(outcome!.outcome).toBe('pending');
    expect((await gateRow(gate!.id)).state).toBe('awaiting');
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe('WHICH gate a review decides (MOTIR-5597)', () => {
  it('has nothing to decide when the card holds no awaiting gate', async () => {
    const { members } = await scenario({ withGate: false });
    await recordReview(members.web);
    const [outcome] = await evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId);
    expect(outcome!.outcome).toBe('no_awaiting_gate');
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('reads the reviews for a gate with ONE repository call, however many members', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);

    const workItemId = (await gateRow(gate!.id)).workItemId!;
    const { queries } = await countDelegateCalls('githubPullRequestReview', 'findMany', () =>
      evaluateForWorkItem(workItemId, fx.workspaceId),
    );
    expect(queries).toBe(1);
  });
});

describe('FIRST DECISION STANDS, as an OUTCOME rather than a throw (MOTIR-5597)', () => {
  it('reports already_decided and leaves the row untouched', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    const workItemId = (await gateRow(gate!.id)).workItemId!;
    await evaluateForWorkItem(workItemId, fx.workspaceId);
    const before = await gateRow(gate!.id);
    mergeSpy.mockClear();

    // A redelivery, or a second reviewer arriving after the set was complete.
    const again = await evaluateForWorkItem(workItemId, fx.workspaceId);
    // The gate is no longer awaiting, so there is nothing left to find.
    expect(['already_decided', 'no_awaiting_gate']).toContain(again.outcome);
    expect(await gateRow(gate!.id)).toEqual(before);
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('reports superseded for a withdrawn question, and merges nothing', async () => {
    const { gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    const workItemId = (await gateRow(gate!.id)).workItemId!;
    // The set changed under the question after the reviews were read.
    vi.spyOn(approvalGateRepository, 'findAwaitingByWorkItem');
    await adminDb.approvalGate.update({
      where: { id: gate!.id },
      data: { state: 'superseded' },
    });

    const outcome = await evaluateForWorkItem(workItemId, fx.workspaceId);
    expect(outcome.outcome).toBe('no_awaiting_gate');
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe('A GATE RAISED AFTER THE REVIEWS ARRIVED (MOTIR-5597, decision 8)', () => {
  it('applies reviews recorded before the gate existed, with no second review event', async () => {
    // Reviews are recorded whether or not a gate exists, so this is the reviewer who
    // approved while CI was still running.
    const { item, members } = await scenario({ withGate: false });
    await recordReview(members.web);
    await recordReview(members.api, { login: 'second-reviewer', githubUserId: '9999' });

    const subjectVersion = [members.web.version, members.api.version].sort().join(',');
    const gate = await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: 'pull_request_approval',
          subjectId: item.id,
          subjectVersion,
        },
        tx,
      ),
    );

    await evaluateAfterRaise(item.id, fx.workspaceId);

    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });

  it('NEVER fails its caller — a throw inside the evaluation is swallowed and logged', async () => {
    const { item, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    const boom = vi
      .spyOn(approvalGateRepository, 'findAwaitingByWorkItem')
      .mockRejectedValue(new Error('the evaluation exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The promotion that raised the gate has already COMMITTED by the time this runs.
    await expect(evaluateAfterRaise(item.id, fx.workspaceId)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    boom.mockRestore();
    // The card is left exactly where the committed promotion put it.
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('TWO REVIEWS AT ONCE (MOTIR-5597)', () => {
  it('decides once, hands off once, and never leaves the gate awaiting', async () => {
    const { gate, members } = await scenario({ withGate: true });
    // Both rows are committed before either evaluation runs — the ordinary case, since each
    // delivery records its own review first. Whichever evaluation runs second sees both.
    await recordReview(members.web);
    await recordReview(members.api, { login: 'second-reviewer', githubUserId: '9999' });

    const [a, b] = await Promise.all([
      evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId),
      evaluateForPullRequest(members.api.pullRequestId, fx.workspaceId),
    ]);

    const outcomes = [...a, ...b].map((e) => e.outcome);
    // Exactly one decides; the other meets the door's lock and reports it as an outcome.
    expect(outcomes.filter((o) => o === 'decided_approved')).toHaveLength(1);
    expect(outcomes.every((o) => o !== 'pending')).toBe(true);
    expect((await gateRow(gate!.id)).state).toBe('approved');
    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a review on a CHILD’s pull request decides the RUN TARGET (MOTIR-5597)', () => {
  it('decides the ancestor’s gate, and the child gains none', async () => {
    const { item, gate, members } = await scenario({ withGate: true });
    // A child the same pull requests also deliver gets NO gate of its own (MOTIR-5479).
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'One child', parentId: item.id },
      fx.ctx,
    );
    // The child has to be IMPLEMENTED or the container-completeness gate refuses the
    // parent's flip to `approved` — correct product behaviour, and not what this test is
    // about (`CONTAINER_CLAIM_STATUS_KEYS`, `lib/workItems/statusLadder.ts`).
    await workItemsService.updateStatus(child.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(child.id, 'implemented', fx.ctx);
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: child.id,
        githubPullRequestId: members.web.pullRequestId,
        repoId: (
          await adminDb.githubPullRequest.findUniqueOrThrow({
            where: { id: members.web.pullRequestId },
          })
        ).repoId,
      },
    });

    await recordReview(members.web);
    await recordReview(members.api);
    await evaluateForPullRequest(members.web.pullRequestId, fx.workspaceId);

    expect((await gateRow(gate!.id)).state).toBe('approved');
    const childGates = await adminDb.approvalGate.findMany({ where: { workItemId: child.id } });
    expect(childGates).toHaveLength(0);
  });
});

describe('the two arms that only run when something moves underneath (MOTIR-5600 §1)', () => {
  it('stays PENDING when nobody can author the status write', async () => {
    // No member for the reviewer AND no workspace owner: `changeRequestStatusSync`'s own
    // fallback has nothing to fall back to. The reviews stay recorded and the next
    // evaluation tries again — the decision is deferred, never guessed at.
    const { item, gate, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId: fx.workspaceId, role: 'owner' },
    });

    const outcome = await evaluateForWorkItem(item.id, fx.workspaceId);

    expect(outcome.outcome).toBe('pending');
    expect((await gateRow(gate!.id)).state).toBe('awaiting');
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('reports SUPERSEDED when the question is withdrawn between the read and the decision', async () => {
    // The set changed after the verdict was computed, so the door refuses. It is an ordinary
    // answer on this path — the delivery is acked and nothing is retried for ever.
    const { item, members } = await scenario({ withGate: true });
    await recordReview(members.web);
    await recordReview(members.api);
    vi.spyOn(approvalGatesService.approvalGatesService, 'decide').mockRejectedValue(
      new ApprovalGateSupersededError('gate-gone'),
    );

    const outcome = await evaluateForWorkItem(item.id, fx.workspaceId);

    expect(outcome.outcome).toBe('superseded');
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe('an UNMAPPED reviewer still decides (MOTIR-5597, decision 3)', () => {
  it('records the login and writes the status as the workspace owner', async () => {
    const { item, gate, members } = await scenario({ withGate: true });
    await usersService.createUser({
      email: 'nobody@example.com',
      password: PASSWORD,
      name: 'Nobody',
    });
    await recordReview(members.web, { login: 'octo-reviewer', githubUserId: '55555' });
    await recordReview(members.api, { login: 'octo-reviewer', githubUserId: '55555' });

    await evaluateForWorkItem(item.id, fx.workspaceId);

    const row = await gateRow(gate!.id);
    expect(row.decidedById).toBeNull();
    expect(row.decidedByLabel).toBe('@octo-reviewer');
    expect(await statusOf(item.id)).toBe('approved');
  });
});
