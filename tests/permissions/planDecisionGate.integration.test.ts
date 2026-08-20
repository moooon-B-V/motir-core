import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// AC4 of Bug MOTIR-3188, against REAL Postgres and a REAL custom role.
//
// The pure suite (`planDecisionSplit.test.ts`) proves the two keys are
// indistinguishable under every BUILT-IN input — which is what makes the split
// behaviour-neutral. This file proves the thing that motivated the split at all:
// that a role which holds one and not the other actually behaves differently, at
// the SERVICE, and not merely in a set the resolution returns.
//
// ⚠️ AT THE SERVICE, NOT AT A ROUTE, deliberately (the card's own words). The
// approve and decline routes assert nothing themselves — they resolve the
// workspace, call one service method and map typed errors — so a route-level
// test would be measuring `aiPlanGateErrorResponse`'s status mapping and would
// pass unchanged if the assertion inside `approvePlan` were deleted.
//
// ⚠️ AND BOTH HALVES ARE ASSERTED. A test that only proved the refusal could not
// tell "the decide key is narrower" from "this role can no longer do anything
// with a plan", and the second is a far worse outcome than the first — the same
// pairing `memberFacingGate.integration.test.ts` makes for its fifteen
// revocations. So the author-only role SUCCEEDS at opening a plan, appending
// proposals and closing it, and is refused only on the two decisions.

const PASSWORD = 'hunter2hunter2';

/** What the "can follow what the planner is proposing" role holds — the role an
 *  admin assembling permissions off the grid would compose. `work_item:edit` is
 *  in it because `plansService.createPlan` asserts that key (Q2 of
 *  `docs/decisions/agent-authored-plans.md`), not because the role is meant to
 *  restructure anything. */
const AUTHOR_ONLY: PermissionKey[] = [
  'project:browse',
  'work_item:edit',
  'ai:view_plan',
  // …and NOT `ai:decide_plan`. That absence is the whole fixture.
];

interface Scenario {
  projectId: string;
  projectKey: string;
  ownerCtx: WorkspaceContext;
  /** A member on a custom role holding {@link AUTHOR_ONLY}. */
  authorCtx: WorkspaceContext;
}

let seq = 0;

async function buildScenario(slug: string): Promise<Scenario> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `pd-owner-${slug}-${seq}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `PD WS ${slug} ${seq}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `PD ${slug}`,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  const role = await projectRoleDefinitionService.create({
    projectId: project.id,
    ctx: ownerCtx,
    name: 'Plan follower',
    permissions: AUTHOR_ONLY,
  });

  const author = await usersService.createUser({
    email: `pd-author-${slug}-${seq}@ex.com`,
    password: PASSWORD,
    name: 'Author',
  });
  await workspacesService.addMember({ userId: author.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: author.id,
    role: 'member',
  });
  await projectMembersService.setRole({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: author.id,
    role: role.id,
  });

  return {
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    authorCtx: { userId: author.id, workspaceId: workspace.id },
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a role holding ai:view_plan and NOT ai:decide_plan', () => {
  it('reads a plan and appends proposals — the half it keeps', async () => {
    const s = await buildScenario('author');

    const plan = await plansService.createPlan(s.projectId, { title: 'A feature' }, s.authorCtx);
    expect(plan.status).toBe('generating');

    const withItems = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A task', kind: 'task' } }],
      s.authorCtx,
    );
    expect(withItems.items).toHaveLength(1);

    // The READ is `canBrowse`, which is the premise the card rests on: this role
    // can open the plan it just wrote without holding either AI key for it.
    const read = await plansService.getPlan(plan.id, s.authorCtx);
    expect(read.items).toHaveLength(1);

    // …and closing the frontier is an AUTHOR write too, so it also passes.
    const planned = await plansService.markPlanned(plan.id, s.authorCtx);
    expect(planned.status).toBe('planned');
  });

  it('is REFUSED on approve, with the shipped typed refusal naming ai:decide_plan', async () => {
    const s = await buildScenario('approve');
    const plan = await plansService.createPlan(s.projectId, { title: 'A feature' }, s.authorCtx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A task', kind: 'task' } }],
      s.authorCtx,
    );
    await plansService.markPlanned(plan.id, s.authorCtx);

    await expect(plansService.approvePlan(plan.id, s.authorCtx)).rejects.toSatisfy(
      (err: unknown) => err instanceof PermissionDeniedError && err.permission === 'ai:decide_plan',
    );

    // NOTHING MATERIALIZED. The refusal happens before the transaction opens, so
    // the proposal is still a proposal — which is the property that makes this a
    // gate rather than a failed write.
    expect(await adminDb.workItem.findFirst({ where: { title: 'A task' } })).toBeNull();
    expect((await plansService.getPlan(plan.id, s.ownerCtx)).status).toBe('planned');
  });

  it('is REFUSED on decline, with the same typed refusal', async () => {
    const s = await buildScenario('decline');
    const plan = await plansService.createPlan(s.projectId, { title: 'A feature' }, s.authorCtx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A task', kind: 'task' } }],
      s.authorCtx,
    );
    await plansService.markPlanned(plan.id, s.authorCtx);

    await expect(plansService.declinePlan(plan.id, s.authorCtx)).rejects.toSatisfy(
      (err: unknown) => err instanceof PermissionDeniedError && err.permission === 'ai:decide_plan',
    );
    expect((await plansService.getPlan(plan.id, s.ownerCtx)).status).toBe('planned');
  });

  it('the project OWNER still approves it — the pairing, so a refusal is not a broken feature', async () => {
    const s = await buildScenario('owner');
    const plan = await plansService.createPlan(s.projectId, { title: 'A feature' }, s.authorCtx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A task', kind: 'task' } }],
      s.authorCtx,
    );
    await plansService.markPlanned(plan.id, s.authorCtx);

    const approved = await plansService.approvePlan(plan.id, s.ownerCtx);
    expect(approved.status).toBe('approved');
    expect(await adminDb.workItem.findFirst({ where: { title: 'A task' } })).not.toBeNull();
  });
});
