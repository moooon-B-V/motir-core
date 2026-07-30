import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the `server-only` pre-plan read the
// repo-set derivation's SECONDARY signal (§0.1.2 `platform`) arrives over. Every
// project, plan, work item and set row below is real Postgres, per the repo's
// no-mocks convention; this is the same seam `projectRepoProposalService.test.ts`
// mocks, for the same reason.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { projectRepoProposalService } from '@/lib/services/projectRepoProposalService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanItemUnknownTargetRepoRoleError } from '@/lib/plans/errors';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The plan → repo ROLE carrier (Story MOTIR-1775 · MOTIR-1912) over real Postgres.
//
// Its sibling `approvePlanTargetRepo.test.ts` proves the SETTLED pin — a proposal
// naming a repository that already exists. This file proves the PORTABLE one, which is the
// pin the onboarding path can actually emit: at generation the repositories DO NOT
// EXIST, so a name is stale or meaningless and only a ROLE is stable (ADR §5.2).
//
// Four things could quietly be wrong, and each has its own describe below:
//
//   1. The role ARRIVES and is RECORDED on the materialized item — it must
//      survive past approve, because the resolution to a repo name cannot happen
//      at approve (the set does not exist yet, and its rows are `proposed`).
//   2. The distinct roles FEED the derivation. This is the criterion the whole
//      Story rests on: a `web` + `api` plan must propose TWO rows. Asserted at the
//      seam (the real argument `proposeRepositorySet` receives) AND at the outcome
//      (the rows that land).
//   3. An unknown role is REJECTED, at both boundaries a role can arrive through,
//      with nothing materialized.
//   4. A plan carrying NO roles behaves EXACTLY as it did before this shipped —
//      the no-regression guard every single-repo project depends on.

/** A pre-plan wire body carrying §0.1.2's signal (the rest is irrelevant here). */
function preplanWith(
  session: { platform?: string | null; designStarter?: string | null } | null,
): RawPreplanStateResponse {
  return {
    session: session === null ? null : (session as RawPreplanStateResponse['session']),
    docs: [],
    catalog: null,
  };
}

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** The work items an approved plan materialized, by title. */
async function itemsByTitle(fx: WorkItemFixture) {
  const rows = await db.workItem.findMany({ where: { projectId: fx.projectId } });
  return new Map(rows.map((r) => [r.title, r]));
}

/** The project's proposed set, in set order. */
function readSet(fx: WorkItemFixture) {
  return projectRepoSetService.listByProject(fx.projectId, fx.ctx);
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
  // The default: a project whose pre-plan recorded no platform, so §0.1.2 is
  // silent and the ROLES are the only signal in play.
  vi.mocked(getPreplanState).mockResolvedValue(preplanWith({ platform: null }));
});

afterAll(async () => {
  await db.$disconnect();
});

describe('approvePlan — the ROLE is recorded on the materialized item', () => {
  it('carries `targetRepoRole` from the proposal onto the work item', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'The web half', kind: 'task', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'The API half', kind: 'task', targetRepoRole: 'api' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const items = await itemsByTitle(fx);
    expect(items.get('The web half')!.targetRepoRole).toBe('web');
    expect(items.get('The API half')!.targetRepoRole).toBe('api');
    // …and NOT resolved to a repo name here. It cannot be: the set is proposed
    // AFTER this transaction commits, and its rows start `proposed`, never
    // established (ADR §5.3) — which is exactly why the role has to be stored.
    expect(items.get('The web half')!.targetRepo).toBeNull();
  });

  it('records the role AND keeps the NAME as the pin when a proposal carries both (§5.4)', async () => {
    // "Role is the portable pin; name is the settled one." A proposal that has
    // both is not a contradiction — it is a re-plan on a project whose repos exist
    // — so the settled answer wins for `targetRepo` and the role is still kept.
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: {
          title: 'Both pins',
          kind: 'task',
          targetRepo: 'acme-api',
          targetRepoRole: 'api',
        },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = (await itemsByTitle(fx)).get('Both pins')!;
    expect(row.targetRepo).toBe('acme-api');
    expect(row.targetRepoRole).toBe('api');
  });

  it('treats an explicit `null` role as UNPINNED, not as an error', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'No role', kind: 'task', targetRepoRole: null } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    expect((await itemsByTitle(fx)).get('No role')!.targetRepoRole).toBeNull();
  });

  it('exposes the role on the plan READ-BACK, for both an `add` and a `modify`', async () => {
    const fx = await makeWorkItemFixture();
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Target' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'Read me' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Pinned add', targetRepoRole: 'mobile' } },
        { op: 'modify', workItemId: target.id, patch: { targetRepoRole: 'shared' } },
      ],
      fx.ctx,
    );

    const read = await plansService.getPlan(plan.id, fx.ctx);
    expect(read.items.find((i) => i.op === 'add')!.proposedFields?.targetRepoRole).toBe('mobile');
    expect(read.items.find((i) => i.op === 'modify')!.patch?.targetRepoRole).toBe('shared');
  });
});

describe('approvePlan — a `modify` patch re-pins and unpins the role', () => {
  it('RE-PINS an existing item', async () => {
    const fx = await makeWorkItemFixture();
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Moving layer' },
      fx.ctx,
    );
    await db.workItem.update({
      where: { id: existing.id },
      data: { targetRepoRole: 'api' },
    });
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepoRole: 'shared' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: existing.id } })).targetRepoRole,
    ).toBe('shared');
  });

  it('UNPINS on an explicit null, and LEAVES the role alone when the patch omits it', async () => {
    // The distinction the sparse-patch contract rests on, mirrored exactly from
    // the shipped `targetRepo` patch: absent ≠ null.
    const fx = await makeWorkItemFixture();
    const cleared = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Cleared' },
      fx.ctx,
    );
    const untouched = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Untouched' },
      fx.ctx,
    );
    await db.workItem.updateMany({
      where: { id: { in: [cleared.id, untouched.id] } },
      data: { targetRepoRole: 'web' },
    });
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: cleared.id, patch: { targetRepoRole: null } },
      { op: 'modify', workItemId: untouched.id, patch: { title: 'Renamed only' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: cleared.id } })).targetRepoRole,
    ).toBe(null);
    const kept = await db.workItem.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(kept.title).toBe('Renamed only');
    expect(kept.targetRepoRole).toBe('web');
  });

  it('does NOT record the role in the revision diff — the feed reports the repo, once that is a fact', async () => {
    const fx = await makeWorkItemFixture();
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Re-roled' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      {
        op: 'modify',
        workItemId: existing.id,
        patch: { title: 'Re-roled once', targetRepoRole: 'infra' },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const revision = await db.workItemRevision.findFirstOrThrow({
      where: { workItemId: existing.id, changeKind: 'updated' },
      orderBy: { changedAt: 'desc' },
    });
    const diff = revision.diff as Record<string, unknown>;
    // The title change IS reported — so this is "no disposition for the role",
    // not "no revision was written".
    expect(diff.title).toEqual({ from: 'Re-roled', to: 'Re-roled once' });
    expect(diff.targetRepoRole).toBeUndefined();
  });
});

describe('approvePlan — the distinct roles FEED the repo-set derivation (ADR §0.1.1)', () => {
  it('hands `proposeRepositorySet` the distinct roles in the plan’s own order', async () => {
    // The seam itself: the derivation's REAL input, read off the call the approve
    // makes. Without this argument the ladder can only ever reach
    // `preplan-platform` / `default-web`, and no plan can propose two repos.
    const fx = await makeWorkItemFixture();
    const spy = vi.spyOn(projectRepoProposalService, 'proposeRepositorySet');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'W1', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'A1', targetRepoRole: 'api' } },
      { op: 'add', proposedFields: { title: 'W2', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'Unpinned' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2]).toEqual({ itemRoles: ['web', 'api'] });
  });

  it('proposes TWO rows for a `web` + `api` plan — `web` first, both `plan-item-role`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'API', targetRepoRole: 'api' } },
      { op: 'add', proposedFields: { title: 'Web', targetRepoRole: 'web' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const set = await readSet(fx);
    const slug = fx.project.slug;
    expect(set.map((r) => [r.role, r.name, r.proposalSignal])).toEqual([
      ['web', `${slug}-web`, 'plan-item-role'],
      ['api', `${slug}-api`, 'plan-item-role'],
    ]);
    // Every row is still only a PROPOSAL — nothing is created, and the user
    // confirms the set at the establish step (ADR §0.2).
    expect(set.every((r) => r.state === 'proposed')).toBe(true);
  });

  it('a plan whose every leaf pins `web` proposes exactly ONE row, with no role suffix', async () => {
    // §1.4 / §6 — the single-repo project is the degenerate case of the same code
    // path, and nothing about its one row may read as "one of several".
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'One', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'Two', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'Three', targetRepoRole: 'web' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const set = await readSet(fx);
    expect(set).toHaveLength(1);
    expect(set[0]!.name).toBe(fx.project.slug);
    expect(set[0]!.role).toBe('web');
    expect(set[0]!.proposalSignal).toBe('plan-item-role');
  });

  it('a `modify`’s role does NOT vote on the set’s cardinality', async () => {
    // A `modify` re-pins an item that already exists; it is not evidence about how
    // many repositories the plan implies.
    const fx = await makeWorkItemFixture();
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Old' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'New web work', targetRepoRole: 'web' } },
      { op: 'modify', workItemId: existing.id, patch: { targetRepoRole: 'infra' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const set = await readSet(fx);
    expect(set.map((r) => r.role)).toEqual(['web']);
    // …but the modify's role IS applied to its target.
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: existing.id } })).targetRepoRole,
    ).toBe('infra');
  });
});

describe('approvePlan — a role outside the vocabulary is REJECTED', () => {
  it('rejects it at the APPEND, naming the offending proposal', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Bad role' }, fx.ctx);

    const err = await plansService
      .addProposals(
        plan.id,
        [
          { op: 'add', proposedFields: { title: 'Good', targetRepoRole: 'web' } },
          {
            op: 'add',
            proposedFields: {
              title: 'The backend',
              targetRepoRole: 'backend' as unknown as 'api',
            },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanItemUnknownTargetRepoRoleError);
    const typed = err as PlanItemUnknownTargetRepoRoleError;
    expect(typed.role).toBe('backend');
    expect(typed.proposalLabel).toContain('The backend');
    // The message names the legal vocabulary, so the producer can self-correct.
    expect(typed.message).toContain('web, api, mobile, shared, infra, other');
    // NOTHING was appended — the whole batch is validated before the transaction.
    expect(await db.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it("rejects `''` and a non-string too — the value arrives as untyped JSON", async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Junk roles' }, fx.ctx);

    for (const junk of ['', 42, { role: 'web' }, ['web']]) {
      await expect(
        plansService.addProposals(
          plan.id,
          [{ op: 'add', proposedFields: { title: 'Junk', targetRepoRole: junk as never } }],
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanItemUnknownTargetRepoRoleError);
    }
    expect(await db.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });

  it('rejects it at APPROVE — and materializes NOTHING', async () => {
    // The backstop for a proposal written before this validation shipped: the
    // append is not the only door, so approve re-checks. Written straight to the
    // row, because `addProposals` now refuses it.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Good', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'Bad', targetRepoRole: 'api' } },
    ]);
    const bad = await db.planItem.findFirstOrThrow({
      where: { planId, proposedFields: { path: ['title'], equals: 'Bad' } },
    });
    await db.planItem.update({
      where: { id: bad.id },
      data: { proposedFields: { title: 'Bad', targetRepoRole: 'backend' } },
    });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanItemUnknownTargetRepoRoleError);
    expect((err as PlanItemUnknownTargetRepoRoleError).planItemId).toBe(bad.id);
    expect((err as PlanItemUnknownTargetRepoRoleError).role).toBe('backend');
    // The tree AND the plan are byte-identical — the rejection runs before the
    // transaction opens, so the GOOD proposal beside it materialized nothing.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('planned');
    expect(plan.decidedAt).toBeNull();
    // …and no repository row was proposed either.
    expect(await readSet(fx)).toHaveLength(0);
  });

  it('rejects a bad role arriving on a `modify` patch', async () => {
    const fx = await makeWorkItemFixture();
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stays put' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'Bad modify' }, fx.ctx);

    const err = await plansService
      .addProposals(
        plan.id,
        [
          {
            op: 'modify',
            workItemId: existing.id,
            patch: { targetRepoRole: 'frontend' as unknown as 'web' },
          },
        ],
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanItemUnknownTargetRepoRoleError);
    expect((err as PlanItemUnknownTargetRepoRoleError).proposalLabel).toContain(existing.id);
    // Nothing about the target moved, and nothing was appended.
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: existing.id } })).targetRepoRole,
    ).toBeNull();
    expect(await db.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });
});

describe('approvePlan — a plan with NO roles behaves exactly as before', () => {
  it('falls through to `default-web` and stores no role', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Plain', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Also plain', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const items = await itemsByTitle(fx);
    expect([...items.values()].every((r) => r.targetRepoRole === null)).toBe(true);
    const set = await readSet(fx);
    expect(set).toHaveLength(1);
    expect(set[0]!.role).toBe('web');
    expect(set[0]!.name).toBe(fx.project.slug);
    expect(set[0]!.proposalSignal).toBe('default-web');
  });

  it('still lets the pre-plan `platform` fix the row when the tree names no role', async () => {
    // §0.1.2 — the rung BELOW the roles. It must keep answering for every project
    // whose producer emits none, which is every project until MOTIR-1885 lands.
    const fx = await makeWorkItemFixture();
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith({ platform: 'mobile' }));
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Plain', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const set = await readSet(fx);
    expect(set.map((r) => [r.role, r.proposalSignal])).toEqual([['mobile', 'preplan-platform']]);
  });

  it('passes an EMPTY `itemRoles` — the seam is wired, the signal is simply absent', async () => {
    const fx = await makeWorkItemFixture();
    const spy = vi.spyOn(projectRepoProposalService, 'proposeRepositorySet');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Plain', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    expect(spy.mock.calls[0]![2]).toEqual({ itemRoles: [] });
  });
});
