import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateSupersededError,
  ApprovalGateSyncedActorMismatchError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE DECIDE DOOR'S SYNCED ACTOR (Story MOTIR-4910 · MOTIR-5596;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 3, 4, 5 and 7),
// against a REAL Postgres.
//
// ⚠️ A SECOND ACTOR SHAPE, NOT A SECOND WRITER. Every test here goes through
// `approvalGatesService.decide` — the same door a press uses, with the same lock, the
// same refusals and the same audit set. `tests/approval-gate-one-language.test.ts`
// passes unedited, which is the property that matters most about this card.

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const PASSWORD = 'hunter2hunter2';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A story in review whose run delivered two green pull requests, holding the card's ONE
 *  approve-to-merge gate over the set — the same shape a press decides. */
async function reviewable() {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

  const versions: string[] = [];
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5596-${seq}`,
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
        repoId: `repo-5596-${seq}`,
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
    versions.push(`acme/${name}#${number}@${head}`);
  }

  const subjectVersion = [...versions].sort().join(',');
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
  return { item, gate, subjectVersion };
}

/** A GitHub identity bound to a user, optionally in ANOTHER workspace. */
async function bindIdentity(opts: {
  email: string;
  githubUserId: string;
  inThisWorkspace: boolean;
}) {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Ada Lovelace',
  });
  if (opts.inThisWorkspace) {
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
    });
  } else {
    await workspacesService.createWorkspace({ name: 'Elsewhere', ownerUserId: user.id });
  }
  await adminDb.githubIdentity.create({
    data: {
      userId: user.id,
      githubUserId: opts.githubUserId,
      githubLogin: 'ada-l',
      accessTokenEncrypted: 'enc',
    },
  });
  return user;
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = (id: string) =>
  adminDb.workItem.findUniqueOrThrow({ where: { id } }).then((i) => i.status);

/** The synced decide call, as the evaluator will make it. */
const syncedDecide = (
  gateId: string,
  decision: 'approve' | 'request_changes',
  synced: { reviewerGithubUserId: string; reviewerLogin: string },
) =>
  approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId, decision, source: 'github' },
    fx.ctx,
    { synced },
  );

describe('a synced decision RESOLVES to a member (MOTIR-5596)', () => {
  it('records the member, their label with the login, github source and github_review authority', async () => {
    const { item, gate, subjectVersion } = await reviewable();
    const member = await bindIdentity({
      email: 'ada@example.com',
      githubUserId: '4242',
      inThisWorkspace: true,
    });

    const result = await syncedDecide(gate.id, 'approve', {
      reviewerGithubUserId: '4242',
      reviewerLogin: 'ada-l',
    });

    expect(result.gate.state).toBe('approved');
    const row = await gateRow(gate.id);
    expect(row.decisionSource).toBe('github');
    // NOT a §2 rung: authority conferred by the host's review permission.
    expect(row.decidedUnderAuthority).toBe('github_review');
    expect(row.decidedById).toBe(member.id);
    expect(row.decidedByLabel).toBe('Ada Lovelace <ada@example.com> (@ada-l)');
    expect(row.outcomeRef).toBe('approved');
    expect(row.subjectVersion).toBe(subjectVersion);
    expect(await statusOf(item.id)).toBe('approved');
  });
});

describe('a synced decision that resolves to NOBODY (MOTIR-5596)', () => {
  it('records a null decider and the login as the whole label — never nobody', async () => {
    const { item, gate } = await reviewable();

    await syncedDecide(gate.id, 'approve', {
      reviewerGithubUserId: '999999',
      reviewerLogin: 'octo-reviewer',
    });

    const row = await gateRow(gate.id);
    expect(row.decidedById).toBeNull();
    // §6b — an unattributable presence must not read as nobody. The pair
    // (source github, decidedById null) is what a surface reads as "not a member".
    expect(row.decidedByLabel).toBe('@octo-reviewer');
    expect(row.decisionSource).toBe('github');
    expect(row.decidedUnderAuthority).toBe('github_review');
    expect(await statusOf(item.id)).toBe('approved');
  });

  it('treats an identity OUTSIDE this workspace exactly as unresolved', async () => {
    const { gate } = await reviewable();
    // A GithubIdentity is global. Without the membership check this reviewer would be
    // recorded as a member of a workspace they have no access to.
    await bindIdentity({
      email: 'stranger@example.com',
      githubUserId: '5555',
      inThisWorkspace: false,
    });

    await syncedDecide(gate.id, 'approve', {
      reviewerGithubUserId: '5555',
      reviewerLogin: 'ada-l',
    });

    const row = await gateRow(gate.id);
    expect(row.decidedById).toBeNull();
    expect(row.decidedByLabel).toBe('@ada-l');
  });
});

describe('a synced REQUEST CHANGES (MOTIR-5596)', () => {
  it('records changes_requested and moves the card nowhere', async () => {
    const { item, gate } = await reviewable();

    await syncedDecide(gate.id, 'request_changes', {
      reviewerGithubUserId: '4242',
      reviewerLogin: 'ada-l',
    });

    const row = await gateRow(gate.id);
    expect(row.state).toBe('changes_requested');
    expect(row.decisionSource).toBe('github');
    expect(row.decidedUnderAuthority).toBe('github_review');
    // A gate's state is not a work item's status (§6b).
    expect(await statusOf(item.id)).toBe('in_review');
  });
});

describe('the SOURCE and the synced actor must arrive together (MOTIR-5596)', () => {
  it('refuses source github with no synced reviewer, and writes nothing', async () => {
    const { gate } = await reviewable();
    // The direction that matters: otherwise a Motir surface could claim to be GitHub.
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'github' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSyncedActorMismatchError);
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('refuses a synced reviewer with any other source, and writes nothing', async () => {
    const { gate } = await reviewable();
    await expect(
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
        {
          synced: { reviewerGithubUserId: '4242', reviewerLogin: 'ada-l' },
        },
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSyncedActorMismatchError);
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });
});

describe('FIRST DECISION STANDS, for a synced one too (MOTIR-5596)', () => {
  it('refuses a decided gate and leaves the row untouched', async () => {
    const { gate } = await reviewable();
    await syncedDecide(gate.id, 'approve', {
      reviewerGithubUserId: '4242',
      reviewerLogin: 'ada-l',
    });
    const before = await gateRow(gate.id);

    await expect(
      syncedDecide(gate.id, 'request_changes', {
        reviewerGithubUserId: '7777',
        reviewerLogin: 'someone-else',
      }),
    ).rejects.toBeInstanceOf(ApprovalGateAlreadyDecidedError);

    expect(await gateRow(gate.id)).toEqual(before);
  });

  it('refuses a superseded gate', async () => {
    const { gate } = await reviewable();
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { state: 'superseded' },
    });
    await expect(
      syncedDecide(gate.id, 'approve', { reviewerGithubUserId: '4242', reviewerLogin: 'ada-l' }),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
  });

  it('records exactly ONE decision when a synced approval and a press race', async () => {
    const { gate } = await reviewable();
    await bindIdentity({ email: 'ada@example.com', githubUserId: '4242', inThisWorkspace: true });

    const results = await Promise.allSettled([
      syncedDecide(gate.id, 'approve', { reviewerGithubUserId: '4242', reviewerLogin: 'ada-l' }),
      approvalGatesService.decide(
        { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
        fx.ctx,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser meets the ordinary terminal-state refusal, not a raw database error.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ApprovalGateAlreadyDecidedError,
    );
    expect((await gateRow(gate.id)).state).toBe('approved');
  });
});

describe('THE DOOR MERGES NOTHING (MOTIR-5596)', () => {
  it('issues no call to the provider merge seam — the merge is MOTIR-5608’s post-commit step', async () => {
    const { gate } = await reviewable();
    const merge = vi.spyOn(github, 'mergeChangeRequest');

    await syncedDecide(gate.id, 'approve', {
      reviewerGithubUserId: '4242',
      reviewerLogin: 'ada-l',
    });

    // Asserted by the ABSENCE of the call: the decision commits first, and the merge is
    // a separate step outside this transaction — exactly as for a press.
    expect(merge).not.toHaveBeenCalled();
  });
});
