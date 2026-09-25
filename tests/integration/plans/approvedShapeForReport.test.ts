import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE SERVER-INTERNAL VERDICT READ (Story MOTIR-5544 · Subtask MOTIR-6284) over
// real Postgres — `plansService.resolveApprovedShapeForReport`, the read beneath
// `resolveApprovedShapeVerdict`'s `ai:view_plan` assertion
// (`docs/decisions/run-found-trigger-dispatched-path.md`, *Its key*).
//
// What is asserted here: it answers the SAME verdict the gated door answers, for
// an actor the gated door REFUSES; it names the approving plan's server-written
// author; and the caller's workspace context still confines it. Every plan is
// created, approved and every card edited through the shipped service paths.
//
// ⚠️ ON "A CLI-GRANT MEMBER". The CLI token's grant is enforced at the MCP tool
// gate (`CLI_TOKEN_GRANT`, `lib/mcp/toolPermissions.ts`); a `ServiceContext`
// carries no grant of its own. The stand-in for "an actor without
// `ai:view_plan`" is therefore a project member whose ROLE lacks the key — and
// each case first proves the gated door refuses that actor, so the stand-in is
// shown to lack the key rather than assumed to.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A project member whose role does not hold `ai:view_plan`. */
async function keylessMemberOf(fx: WorkItemFixture): Promise<ServiceContext> {
  const user = await createTestUser({ name: 'Keyless' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'viewer',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** Add one card through `planId`, close it and approve it; return the card id. */
async function approveWithOneAdd(fx: WorkItemFixture, planId: string): Promise<string> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title: 'Born', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
  const row = await adminDb.planItem.findFirstOrThrow({ where: { planId, op: 'add' } });
  return row.workItemId!;
}

/** A card born of an approved plan whose row carries `native` (motir-ai's). */
async function nativeBorn(fx: WorkItemFixture): Promise<{ planId: string; id: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'A native plan',
      authorSource: 'native',
      authorHarness: 'Motir',
      authorModel: 'motir-planner',
    },
    fx.ctx,
  );
  return { planId: plan.id, id: await approveWithOneAdd(fx, plan.id) };
}

/** A card born of a plan written through the `create_plan` MCP door. */
async function mcpBorn(fx: WorkItemFixture): Promise<{ planId: string; id: string }> {
  const server = buildMcpServer(() => fx.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'approved-shape-for-report', version: '0.0.0' });
  await client.connect(clientTransport);
  const result = (await client.callTool({
    name: 'create_plan',
    arguments: {
      projectKey: fx.projectIdentifier,
      title: 'An MCP plan',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5-5',
    },
  })) as CallToolResult;
  expect(result.isError ?? false).toBe(false);
  await client.close();
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { projectId: fx.projectId, title: 'An MCP plan' },
  });
  return { planId: plan.id, id: await approveWithOneAdd(fx, plan.id) };
}

/** The gated verdict under the full-access owner. */
const gated = async (fx: WorkItemFixture, id: string) =>
  (await plansService.resolveApprovedShapeVerdict(fx.projectId, [id], fx.ctx)).items[0]!;

describe('the SAME verdict the gated door answers, for an actor it refuses', () => {
  it('unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const keyless = await keylessMemberOf(fx);
    const born = await nativeBorn(fx);

    await expect(
      plansService.resolveApprovedShapeVerdict(fx.projectId, [born.id], keyless),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const report = await plansService.resolveApprovedShapeForReport(fx.projectId, born.id, keyless);
    expect(report.verdict.verdict).toBe('unchanged');
    expect(report.verdict).toEqual(await gated(fx, born.id));
  });

  it('changed', async () => {
    const fx = await makeWorkItemFixture();
    const keyless = await keylessMemberOf(fx);
    const born = await nativeBorn(fx);
    await workItemsService.updateWorkItem(born.id, { descriptionMd: 'Rewritten.' }, fx.ctx);

    await expect(
      plansService.resolveApprovedShapeVerdict(fx.projectId, [born.id], keyless),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const report = await plansService.resolveApprovedShapeForReport(fx.projectId, born.id, keyless);
    expect(report.verdict.verdict).toBe('changed');
    expect(report.verdict.divergingRevision).not.toBeNull();
    expect(report.verdict).toEqual(await gated(fx, born.id));
  });

  it('no_plan — and approvingPlan is null exactly then', async () => {
    const fx = await makeWorkItemFixture();
    const keyless = await keylessMemberOf(fx);
    const plain = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Never planned' },
      fx.ctx,
    );

    await expect(
      plansService.resolveApprovedShapeVerdict(fx.projectId, [plain.id], keyless),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const report = await plansService.resolveApprovedShapeForReport(
      fx.projectId,
      plain.id,
      keyless,
    );
    expect(report.verdict.verdict).toBe('no_plan');
    expect(report.verdict).toEqual(await gated(fx, plain.id));
    expect(report.approvingPlan).toBeNull();
  });
});

describe("the approving plan's SERVER-WRITTEN author", () => {
  it('a plan written through `create_plan` (the MCP door) reads `mcp`', async () => {
    const fx = await makeWorkItemFixture();
    const born = await mcpBorn(fx);

    const report = await plansService.resolveApprovedShapeForReport(fx.projectId, born.id, fx.ctx);
    expect(report.approvingPlan).toEqual({
      id: born.planId,
      title: 'An MCP plan',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5-5',
    });
  });

  it('a plan whose row carries `native` reads `native`', async () => {
    const fx = await makeWorkItemFixture();
    const born = await nativeBorn(fx);

    const report = await plansService.resolveApprovedShapeForReport(fx.projectId, born.id, fx.ctx);
    expect(report.approvingPlan).toEqual({
      id: born.planId,
      title: 'A native plan',
      authorSource: 'native',
      authorHarness: 'Motir',
      authorModel: 'motir-planner',
    });
    // The row itself says so — the read did not invent it.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: born.planId } });
    expect(row.authorSource).toBe('native');
  });
});

describe("the caller's workspace context still confines it", () => {
  it('a work item in ANOTHER workspace is not found — its approved plan is invisible', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MINE' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THRS' });
    const born = await nativeBorn(theirs);

    // In its OWN workspace the card has an approving plan…
    const own = await plansService.resolveApprovedShapeForReport(
      theirs.projectId,
      born.id,
      theirs.ctx,
    );
    expect(own.verdict.verdict).toBe('unchanged');
    expect(own.approvingPlan?.id).toBe(born.planId);

    // …and from ANOTHER workspace's context, even naming their project, nothing
    // of it is found.
    for (const projectId of [theirs.projectId, mine.projectId]) {
      const foreign = await plansService.resolveApprovedShapeForReport(
        projectId,
        born.id,
        mine.ctx,
      );
      expect(foreign.verdict).toMatchObject({ verdict: 'no_plan', planId: null, planTitle: null });
      expect(foreign.approvingPlan).toBeNull();
    }
  });
});
