import { type GithubRepo } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import { resolveItemDispatchRepo } from '@/lib/workItems/dispatchRepo';
import { PlanItemUnknownTargetRepoError } from '@/lib/plans/errors';
import type { ProposalInput } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';

// The plan → materialize REPO PIN (Story MOTIR-1775 · MOTIR-1884) over real
// Postgres. The seam this proves is what makes a TWO-repo project dispatchable at
// all: `resolveDispatchRepo` falls back to "the single repo" only when there is
// exactly one, so without a pin travelling from the plan onto the work item,
// every item in a two-repo project resolves to `null` and no agent is told where
// to build.
//
// What is pinned here is each place it could quietly be wrong:
//
//   1. The pin ARRIVES — an `add` carrying `targetRepo` materializes a work item
//      with that pin, normalized to the bare name (the `owner/name` spelling of a
//      valid repo is ACCEPTED, since that is the form the GitHub surfaces show).
//   2. A `modify` patch RE-PINS, and an explicit null UNPINS — the two halves of
//      "a re-plan can move work from one repo of the set to another".
//   3. A bad pin is REJECTED with a typed error naming the PROPOSAL — not
//      silently dropped, and not stored as an accepted lie that only fails much
//      later, at dispatch, as an agent in the wrong working tree.
//   4. Validation reads the PROJECT's set, not the workspace's — a repo that
//      belongs to a SIBLING project of the same workspace is rejected. This is the
//      test that proves the project association is actually being used.
//   5. A pin to a row that is still `proposed` is ACCEPTED — the plan names
//      repositories before it creates them, so recording that intent is ordinary.
//   6. BACKWARD COMPATIBILITY — a proposal carrying no `targetRepo` materializes
//      exactly as it did before the field existed.
//
// Real Postgres, no mocks (the repo convention).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect one repo to the workspace — the 7.10.3 installation mirror rows a set
 *  row realizes against (mirrors `tests/projectRepos/projectRepoSetService.test.ts`). */
async function connectRepo(workspaceId: string, name: string, owner = 'acme'): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}-github`;
  const inst = await db.githubInstallation.upsert({
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
  return db.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: workspaceId,
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

/** Give a project an ESTABLISHED set row for `name` — a row plus the realized
 *  repo it points at, which is what makes the name dispatchable as well as
 *  pinnable. */
async function establishRepo(
  projectId: string,
  fx: WorkItemFixture,
  name: string,
  role: 'web' | 'api' | 'infra' = 'web',
  owner = 'acme',
): Promise<void> {
  const row = await projectRepoSetService.addRow(projectId, { role, name }, fx.ctx);
  const repo = await connectRepo(fx.workspaceId, name, owner);
  await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
}

/** A project whose architecture decided on TWO repos — the case the single-repo
 *  fallback cannot answer, and therefore the case this card exists for. */
async function twoRepoProject(fx: WorkItemFixture): Promise<void> {
  await establishRepo(fx.projectId, fx, 'acme-web', 'web');
  await establishRepo(fx.projectId, fx, 'acme-api', 'api');
}

/** Create a plan, append the given proposals, and mark it `planned`. */
async function plannedPlan(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** The single work item a one-`add` plan materialized. */
async function materializedItem(planId: string) {
  const item = await db.planItem.findFirstOrThrow({ where: { planId, op: 'add' } });
  return db.workItem.findUniqueOrThrow({ where: { id: item.workItemId! } });
}

describe('approvePlan — an `add` carries the repo pin onto the work item', () => {
  it('materializes the pin, and RESOLVES the two-repo case a bare fallback cannot', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'The API half', kind: 'task', targetRepo: 'acme-api' },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await materializedItem(planId);
    expect(row.targetRepo).toBe('acme-api');
    // The point of the pin: with TWO repos in the set, dispatch has no
    // non-arbitrary default — the pin is the only thing that answers. Asserted
    // through the SAME resolver every dispatch surface calls.
    expect((await resolveItemDispatchRepo(row.targetRepo, row.projectId, fx.ctx))?.name).toBe(
      'acme-api',
    );
    // …and without the pin, this project's items resolve to nothing at all — the
    // gap this card closes.
    expect(await resolveItemDispatchRepo(null, row.projectId, fx.ctx)).toBeNull();
  });

  it('ACCEPTS the `owner/name` spelling and stores the bare name', async () => {
    // `owner/name` is the form the GitHub surfaces and `resolveCodeContext`
    // display, so a planner that copies a repo from there must get the same result
    // as one that types the short name.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Web half', kind: 'task', targetRepo: 'acme/acme-web' },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    expect((await materializedItem(planId)).targetRepo).toBe('acme-web');
  });

  it('stores the SET’s casing, so the column and `.motir.json` cannot disagree', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx.projectId, fx, 'Acme-Core', 'web', 'Acme');
    await establishRepo(fx.projectId, fx, 'acme-api', 'api');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Core', kind: 'task', targetRepo: 'acme-core' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    expect((await materializedItem(planId)).targetRepo).toBe('Acme-Core');
  });

  it('ACCEPTS a pin to a row that is still `proposed` — intent is legal before the repo exists', async () => {
    // A plan names repositories before it creates them (the set's whole point), so
    // pinning to an unrealized row is ordinary. The item simply is not dispatchable
    // until that row resolves — which is the project's honest state, not a reason
    // to clear the pin.
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'not-yet-built' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Ahead of the repo', targetRepo: 'not-yet-built' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const row = await materializedItem(planId);
    expect(row.targetRepo).toBe('not-yet-built');
    // Recorded, but not dispatchable: Motir knows the NAME and admits it cannot
    // say where it lives.
    const dispatch = await resolveItemDispatchRepo(row.targetRepo, row.projectId, fx.ctx);
    expect(dispatch?.name).toBe('not-yet-built');
    expect(dispatch?.cloneUrl).toBeNull();
  });

  it('records the pin in the CREATED revision, through the shipped renderer disposition', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Pinned', targetRepo: 'acme-web' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const row = await materializedItem(planId);
    const revision = await db.workItemRevision.findFirstOrThrow({
      where: { workItemId: row.id, changeKind: 'created' },
    });
    expect((revision.diff as Record<string, unknown>).targetRepo).toEqual({
      from: null,
      to: 'acme-web',
    });
  });
});

describe('approvePlan — a `modify` patch re-pins and unpins', () => {
  it('RE-PINS an existing item and logs one `targetRepo` diff cell', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Built in the wrong repo',
        targetRepo: 'acme-web',
      },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepo: 'acme-api' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await db.workItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.targetRepo).toBe('acme-api');
    const revision = await db.workItemRevision.findFirstOrThrow({
      where: { workItemId: existing.id, changeKind: 'updated' },
      orderBy: { changedAt: 'desc' },
    });
    expect((revision.diff as Record<string, unknown>).targetRepo).toEqual({
      from: 'acme-web',
      to: 'acme-api',
    });
  });

  it('UNPINS on an explicit null', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned today', targetRepo: 'acme-web' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepo: null } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    expect(
      (await db.workItem.findUniqueOrThrow({ where: { id: existing.id } })).targetRepo,
    ).toBeNull();
  });

  it('LEAVES the pin untouched when the patch does not mention it (absent ≠ null)', async () => {
    // The distinction the whole sparse-patch contract rests on: a re-plan that
    // re-titles an item must not silently unpin it.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Old title', targetRepo: 'acme-web' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { title: 'New title' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const row = await db.workItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.title).toBe('New title');
    expect(row.targetRepo).toBe('acme-web');
  });

  it('logs NO `targetRepo` diff when the patch re-pins to the value already stored', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Already right', targetRepo: 'acme-web' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepo: 'acme/acme-web' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const revision = await db.workItemRevision.findFirstOrThrow({
      where: { workItemId: existing.id, changeKind: 'updated' },
      orderBy: { changedAt: 'desc' },
    });
    expect((revision.diff as Record<string, unknown>).targetRepo).toBeUndefined();
  });
});

describe('approvePlan — a pin outside the project’s set is REJECTED', () => {
  it('rejects a plausible TYPO with a typed error naming the proposal and the offending name', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Typo', kind: 'task', targetRepo: 'acme-apo' } },
    ]);
    const planItem = await db.planItem.findFirstOrThrow({ where: { planId } });

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanItemUnknownTargetRepoError);
    const typed = err as PlanItemUnknownTargetRepoError;
    expect(typed.planItemId).toBe(planItem.id);
    expect(typed.repoName).toBe('acme-apo');
    // The message names the project's repositories, so the author can self-correct.
    expect(typed.message).toContain('acme-api');
    expect(typed.message).toContain('acme-web');
  });

  it('leaves the tree AND the plan byte-identical — nothing is half-applied', async () => {
    // The rejection runs before the transaction opens, so an approve that names one
    // bad repo among good ones must materialize NONE of them.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Good', kind: 'task', targetRepo: 'acme-web' } },
      { op: 'add', proposedFields: { title: 'Bad', kind: 'task', targetRepo: 'nope' } },
    ]);
    const before = await db.workItem.count({ where: { projectId: fx.projectId } });

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanItemUnknownTargetRepoError,
    );

    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    expect(await db.workItem.findFirst({ where: { title: 'Good' } })).toBeNull();
    const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('planned');
    expect(plan.decidedAt).toBeNull();
  });

  it('rejects a bad pin arriving on a `modify` patch too', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const existing = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stays put', targetRepo: 'acme-web' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      { op: 'modify', workItemId: existing.id, patch: { targetRepo: 'acme-wibble' } },
    ]);

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanItemUnknownTargetRepoError,
    );
    expect((await db.workItem.findUniqueOrThrow({ where: { id: existing.id } })).targetRepo).toBe(
      'acme-web',
    );
  });

  it('rejects a SIBLING project’s repo — validation reads the PROJECT’s set, not the workspace’s', async () => {
    // The test that proves the project association is actually being used: under
    // workspace-wide validation this pin was ACCEPTED, and the item then dispatched
    // an agent into a checkout that has nothing to do with its project.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHER',
      name: 'Other',
    });
    await establishRepo(sibling.id, fx, 'other-service', 'api');

    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Wrong project', targetRepo: 'other-service' } },
    ]);

    const err = await plansService.approvePlan(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanItemUnknownTargetRepoError);
    expect((err as PlanItemUnknownTargetRepoError).repoName).toBe('other-service');
    // …and the sibling's repo IS valid in the sibling's own plan, which is what
    // makes this a scoping rule rather than a spelling rule.
    const siblingPlan = await plansService.createPlan(sibling.id, { title: 'Theirs' }, fx.ctx);
    await plansService.addProposals(
      siblingPlan.id,
      [{ op: 'add', proposedFields: { title: 'Right project', targetRepo: 'other-service' } }],
      fx.ctx,
    );
    await plansService.markPlanned(siblingPlan.id, fx.ctx);
    await plansService.approvePlan(siblingPlan.id, fx.ctx);
    expect((await materializedItem(siblingPlan.id)).targetRepo).toBe('other-service');
  });

  it('rejects ANY pin when the project’s set is empty but the WORKSPACE has repos', async () => {
    // A project that HAS planned its repositories is answered by that plan alone —
    // but a project with NO set falls back to the workspace's connected repos (the
    // ADR's compatibility path). Here the set is empty, so the workspace answers,
    // and a name outside it is still rejected.
    const fx = await makeWorkItemFixture();
    await connectRepo(fx.workspaceId, 'workspace-only');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Unknown', targetRepo: 'not-connected' } },
    ]);

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanItemUnknownTargetRepoError,
    );
  });
});

describe('approvePlan — backward compatibility (no pin)', () => {
  it('materializes an unpinned proposal EXACTLY as before, and keeps the single-repo fallback', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx.projectId, fx, 'acme-web', 'web');
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'No pin', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await materializedItem(planId);
    // The COLUMN stays null — the pin is for explicit decisions only, never a
    // frozen guess (the reason resolution happens at dispatch).
    expect(row.targetRepo).toBeNull();
    // …and the shipped single-repo fallback still answers, unchanged.
    expect((await resolveItemDispatchRepo(row.targetRepo, row.projectId, fx.ctx))?.name).toBe(
      'acme-web',
    );
  });

  it('needs NO repo-set read at all for a plan that carries no pins', async () => {
    // A project with no set and no connected repos would have nothing to validate
    // against; an unpinned plan must not care. (The resolver short-circuits before
    // it reads a domain — which is also what keeps an unpin from failing on a
    // project whose set the actor may not browse.)
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'Plain', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Also plain', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);
    const rows = await db.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.targetRepo === null)).toBe(true);
  });

  it('resolves ONE domain read per distinct spelling, not one per item', async () => {
    // A plan pins many items to the same few repos; the domain read is per call, so
    // the resolution is memoized. Proved by materializing a mixed batch and
    // asserting every pin landed — the behaviour the memo must not change.
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'W1', targetRepo: 'acme-web' } },
      { op: 'add', proposedFields: { title: 'W2', targetRepo: 'acme-web' } },
      { op: 'add', proposedFields: { title: 'A1', targetRepo: 'acme/acme-api' } },
      { op: 'add', proposedFields: { title: 'Unpinned' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const byTitle = new Map(
      (await db.workItem.findMany({ where: { projectId: fx.projectId } })).map((r) => [
        r.title,
        r.targetRepo,
      ]),
    );
    expect(byTitle.get('W1')).toBe('acme-web');
    expect(byTitle.get('W2')).toBe('acme-web');
    expect(byTitle.get('A1')).toBe('acme-api');
    expect(byTitle.get('Unpinned')).toBeNull();
  });
});

describe('the pin survives the plan READ-BACK', () => {
  it('exposes `targetRepo` on the plan DTO so a client can show what was proposed', async () => {
    const fx = await makeWorkItemFixture();
    await twoRepoProject(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Read me' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'Pinned add', targetRepo: 'acme-api' } },
        {
          op: 'modify',
          workItemId: (
            await workItemsService.createWorkItem(
              { projectId: fx.projectId, kind: 'task', title: 'Target' },
              fx.ctx,
            )
          ).id,
          patch: { targetRepo: 'acme-web' },
        },
      ],
      fx.ctx,
    );

    const read = await plansService.getPlan(plan.id, fx.ctx);
    const add = read.items.find((i) => i.op === 'add')!;
    const modify = read.items.find((i) => i.op === 'modify')!;
    expect(add.proposedFields?.targetRepo).toBe('acme-api');
    expect(modify.patch?.targetRepo).toBe('acme-web');
  });
});
