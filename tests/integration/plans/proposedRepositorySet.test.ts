import { type GithubRepo } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectedWorkItem } from '@/lib/services/planProjectionService';
import { PlanItemUnknownTargetRepoError } from '@/lib/plans/errors';
import { ConflictingTargetRepoInputError } from '@/lib/workItems/errors';
import type { ProposalInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import { organizationIdOf } from '../../helpers/organizationOf';

// A repository SET can be PROPOSED (bug MOTIR-4904) — over real Postgres, end to
// end through `approvePlan`.
//
// ── What was wrong ──────────────────────────────────────────────────────────
// Every plan-authoring door took only the SINGULAR `targetRepo`, while the
// direct work-item door has taken the SET since Story MOTIR-2725. So a story or
// task that legitimately ships in more than one repository could only be given
// its set AFTER approval, with `update_work_item` — outside the plan, after the
// review, with no diff for the approver to have seen. And a planning pass may
// not use the direct door at all (the only work item any pass creates directly
// is a `bug`), so for a planner the set was not awkward but INEXPRESSIBLE.
//
// The window in between is the part that bites: dispatch routes on the repo pin,
// so an approved-but-not-yet-patched card is claimable and will be sent to ONE
// repository for work that ships in two.
//
// ── What this file pins, and why each case is here ──────────────────────────
//   1. An `add` carrying `targetRepos` MATERIALIZES the ordered set — the names
//      column, the scalar primary, and one reference per member, in order.
//   2. The ROW-ID spelling does the same, since that is the form that survives a
//      rename and is the one an agent holding ids should reach for.
//   3. A `modify`'s patch RE-PINS an existing card's whole set — the re-plan
//      case, which is where the bug was found.
//   4. The CORRECTION door reaches it on a `planned` plan, and REPLACES the axis
//      rather than merging a contradiction into it.
//   5. Every door REFUSES a proposal describing the axis twice — through the
//      direct door's own guard, so the two cannot disagree about what a
//      contradiction is.
//   6. An unknown member is refused, naming the PROPOSAL.
//   7. The PROJECTION reports the proposed set, so the pre-close check can see a
//      two-repository card before anyone approves it.
//
// Real Postgres, no mocks (the repo convention).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect one repo to the workspace — the installation mirror row a set row
 *  realizes against (mirrors `approvePlanTargetRepo.test.ts`). */
async function connectRepo(workspaceId: string, name: string, owner = 'acme'): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

async function establishRepo(
  fx: WorkItemFixture,
  name: string,
  role: 'web' | 'api' | 'infra',
): Promise<string> {
  const row = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  const repo = await connectRepo(fx.workspaceId, name);
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
  return row.id;
}

/** A project whose architecture decided on TWO repositories — the case the
 *  single-repo fallback cannot answer, and therefore the case this exists for. */
async function twoRepoProject(fx: WorkItemFixture): Promise<{ web: string; api: string }> {
  return {
    web: await establishRepo(fx, 'acme-web', 'web'),
    api: await establishRepo(fx, 'acme-api', 'api'),
  };
}

async function plannedPlan(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function materializedItem(planId: string) {
  const item = await adminDb.planItem.findFirstOrThrow({ where: { planId, op: 'add' } });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: item.workItemId! } });
}

/** An item's stored REFERENCES, in set order, as repository names. */
async function repoRefNames(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRepo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
    include: { projectRepo: true },
  });
  return rows.map((r) => r.projectRepo.name);
}

describe('an `add` PROPOSES a repository set', () => {
  it('materializes the ORDERED set — names, primary and one reference per member', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'The contract, both halves',
          kind: 'task',
          targetRepos: ['acme-api', 'acme-web'],
        },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await materializedItem(planId);
    // The SET, in the order it was authored. Element 0 is the PRIMARY, so this
    // is an ordered assertion and not a set-membership one: `[api, web]` and
    // `[web, api]` are different decisions about where dispatch sends the agent.
    expect(row.targetRepos).toEqual(['acme-api', 'acme-web']);
    expect(row.targetRepo).toBe('acme-api');
    // …and the REFERENCES beside them, which is what survives a rename and what
    // the completion gate resolves through.
    expect(await repoRefNames(row.id)).toEqual(['acme-api', 'acme-web']);
  });

  it('takes the ROW-ID spelling too, and lands the same set', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Pinned by reference',
          kind: 'task',
          targetRepositories: [rows.web, rows.api],
        },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await materializedItem(planId);
    expect(row.targetRepos).toEqual(['acme-web', 'acme-api']);
    expect(row.targetRepo).toBe('acme-web');
    expect(await repoRefNames(row.id)).toEqual(['acme-web', 'acme-api']);
  });

  it('leaves the SINGULAR pin writing the one-element set it means', async () => {
    // ⚠️ NOT a redundant restatement of the shipped `targetRepo` behaviour.
    // `materialize` wrote the scalar and the reference and left
    // `work_item.targetRepos` at its `[]` default — and `resolveExpectedRepos`
    // returns EARLY on an empty names array, so the completion gate had nothing
    // to hold a plan-materialized card open on. The two doors now agree about
    // what a pinned card looks like, whichever spelling pinned it.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'One repo', kind: 'task', targetRepo: 'acme-web' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await materializedItem(planId);
    expect(row.targetRepo).toBe('acme-web');
    expect(row.targetRepos).toEqual(['acme-web']);
  });

  it('REFUSES an `add` that describes the axis twice', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Contradiction' }, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'add',
            proposedFields: {
              title: 'Both spellings',
              kind: 'task',
              targetRepo: 'acme-web',
              targetRepos: ['acme-api'],
            },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictingTargetRepoInputError);
  });

  it('REFUSES an unknown member, naming the proposal rather than dropping it', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Typo', kind: 'task', targetRepos: ['acme-api', 'acme-apo'] },
      },
    ]);

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanItemUnknownTargetRepoError,
    );
    // All-or-nothing: nothing was materialized, so the tree is byte-identical.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('a `modify` RE-PINS an existing card’s whole set', () => {
  it('replaces the set, the primary and the references — the re-plan case', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Thought to be one repo' },
      fx.ctx,
    );
    await workItemsService.updateWorkItem(existing.id, { targetRepo: 'acme-web' }, fx.ctx);

    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: existing.id,
        patch: { targetRepos: ['acme-api', 'acme-web'] },
      },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.targetRepos).toEqual(['acme-api', 'acme-web']);
    expect(row.targetRepo).toBe('acme-api');
    expect(await repoRefNames(existing.id)).toEqual(['acme-api', 'acme-web']);
  });

  it('UNPINS on an explicit empty set', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned today', targetRepo: 'acme-web' },
      fx.ctx,
    );

    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepos: [] } },
    ]);
    await plansService.approvePlan(planId, fx.ctx);

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.targetRepos).toEqual([]);
    expect(row.targetRepo).toBeNull();
    expect(await repoRefNames(existing.id)).toEqual([]);
  });

  it('REFUSES a patch that describes the axis twice', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Target' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'Contradiction' }, fx.ctx);
    await expect(
      plansService.addProposals(
        plan.id,
        [
          {
            op: 'modify',
            workItemId: existing.id,
            patch: { targetRepo: 'acme-web', targetRepositories: ['whatever'] },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictingTargetRepoInputError);
  });
});

describe('the CORRECTION door reaches the set on a `planned` plan', () => {
  it('REPLACES the axis rather than merging a contradiction into it', async () => {
    // The shape the whole bug was found through: a plan already in front of a
    // reviewer, pinned to one repository, that turns out to span two.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two homes' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Spans both', kind: 'task', targetRepo: 'acme-web' },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const planItemId = appended.items[0]!.id;

    await plansService.correctProposal(
      plan.id,
      planItemId,
      { targetRepos: ['acme-api', 'acme-web'] },
      fx.ctx,
    );

    // ⚠️ The SINGULAR is GONE, not left standing beside the set. A proposal
    // carrying both is exactly the state the append refuses, and approve would
    // then have to invent a precedence rule over something nobody authored.
    const stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } });
    expect(stored.proposedFields).toMatchObject({ targetRepos: ['acme-api', 'acme-web'] });
    expect(stored.proposedFields).not.toHaveProperty('targetRepo');

    await plansService.approvePlan(plan.id, fx.ctx);
    const row = await materializedItem(plan.id);
    expect(row.targetRepos).toEqual(['acme-api', 'acme-web']);
    expect(await repoRefNames(row.id)).toEqual(['acme-api', 'acme-web']);
  });

  it('REFUSES a correction that describes the axis twice', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two homes' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Spans both', kind: 'task' } }],
      fx.ctx,
    );

    await expect(
      plansService.correctProposal(
        plan.id,
        appended.items[0]!.id,
        { targetRepo: 'acme-web', targetRepos: ['acme-api'] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictingTargetRepoInputError);
  });
});

describe('the PROJECTION reports the proposed set', () => {
  it('shows both repositories before anyone approves the plan', async () => {
    // The pre-close check reads the projection, so a set it could not see would
    // be a set the author cannot verify they proposed — which is how the
    // after-the-fact patch became the remedy on the record in the first place.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two homes' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Spans both',
            kind: 'task',
            targetRepos: ['acme-api', 'acme-web'],
          },
        },
      ],
      fx.ctx,
    );

    const projected = await projectedWorkItem(plan.id, `planItem:${appended.items[0]!.id}`, fx.ctx);
    expect(projected.target.targetRepos).toEqual(['acme-api', 'acme-web']);
    expect(projected.target.targetRepo).toBeNull();
  });

  it('reports a SINGULAR pin as the one-element set it means', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'One home' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One repo', kind: 'task', targetRepo: 'acme-web' } }],
      fx.ctx,
    );

    const projected = await projectedWorkItem(plan.id, `planItem:${appended.items[0]!.id}`, fx.ctx);
    expect(projected.target.targetRepos).toEqual(['acme-web']);
  });
});
