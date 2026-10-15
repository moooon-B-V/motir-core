import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { RunFoundReportReasonInvalidError } from '@/lib/dispatchRuns/errors';
import { buildMcpServer } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import {
  runFoundReportService,
  type RunFoundReportAcknowledgement,
} from '@/lib/services/runFoundReportService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { RUN_TOKEN_ROUTES } from '@/lib/hostedRuns/runTokenRoutes';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { bearer } from './fixtures/apiV1Fixtures';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from './helpers/workspaceRoleFixtures';

// THE RUN-FOUND REPORT SERVICE (Story MOTIR-5544 · Subtask MOTIR-6285) against a
// real Postgres — `runFoundReportService.reportUnbuildableTarget`, the arms of
// `docs/decisions/run-found-trigger-dispatched-path.md` in the record's order:
// no open leg → nothing; `no_plan` → record; not `native` → record; `changed` →
// record; `native` and `unchanged` → record and file ONE planning bug into
// Motir's planner-bug home, as the system principal.
//
// Every plan is created and approved, every card edited, every run opened and
// every leg claimed through the shipped services. The customer-tenant cases are
// driven by a CLI-GRANT member: a `ServiceContext` carries no grant of its own
// (the grant is enforced at the MCP gate), so the stand-in is a project member
// whose custom role holds EXACTLY `CLI_TOKEN_GRANT`'s keys and whose context is
// bound to the project like a CLI token's — and the suite first proves that
// actor lacks `ai:view_plan`, so an RLS or permission denial on the leg read
// cannot pass as "no open leg".

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const REASON = 'SENTINEL-REASON: the card names a table that does not exist';
const ON_RUN: RunFoundReportAcknowledgement = { acknowledged: true, recordedOnRun: true };
const NOT_ON_RUN: RunFoundReportAcknowledgement = { acknowledged: true, recordedOnRun: false };

interface Meta {
  fx: WorkItemFixture;
  planningFolderId: string;
}

/** Motir's own tenant: the `MOTIR` meta project, its `Planning bugs` folder
 *  pointed at as the planner-bug destination, and (by default) the system
 *  principal — the seed's shape. */
async function makeMeta(opts: { principal?: boolean } = {}): Promise<Meta> {
  const fx = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
  const planning = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Planning bugs' },
    fx.ctx,
  );
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { plannerBugDestinationFolderId: planning.id },
  });
  if (opts.principal !== false) {
    await seedSystemPrincipal({ workspaceId: fx.workspaceId, projectId: fx.projectId });
  }
  return { fx, planningFolderId: planning.id };
}

/** A member whose custom role holds exactly `permissions`, bound to the project
 *  as a CLI token is. */
async function memberWithRole(
  fx: WorkItemFixture,
  name: string,
  permissions: readonly string[],
): Promise<ServiceContext> {
  const user = await createTestUser({ name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name,
    permissions: [...permissions],
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return { userId: user.id, workspaceId: fx.workspaceId, tokenProjectId: fx.projectId };
}

const cliGrantMemberOf = (fx: WorkItemFixture) => memberWithRole(fx, 'CLI agent', CLI_TOKEN_GRANT);

interface Card {
  id: string;
  key: string;
  planId: string | null;
}

/** Add one card through `planId`, close and approve the plan; return the card. */
async function approveWithOneAdd(
  fx: WorkItemFixture,
  planId: string,
  title: string,
): Promise<Card> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
  const row = await adminDb.planItem.findFirstOrThrow({ where: { planId, op: 'add' } });
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId! } });
  return { id: item.id, key: item.identifier, planId };
}

/** A card born of an approved plan with the given server-written author. */
async function planBorn(
  fx: WorkItemFixture,
  authorSource: 'native' | null,
  opts: { planTitle?: string; title?: string } = {},
): Promise<Card> {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: opts.planTitle ?? 'A plan',
      ...(authorSource === 'native'
        ? { authorSource: 'native', authorHarness: 'Motir', authorModel: 'motir-planner' }
        : {}),
    },
    fx.ctx,
  );
  return approveWithOneAdd(fx, plan.id, opts.title ?? 'A planned card');
}

/** A card born of a plan written through the `create_plan` MCP door (`mcp`). */
async function mcpBorn(fx: WorkItemFixture): Promise<Card> {
  const server = buildMcpServer(() => fx.ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'run-found-report', version: '0.0.0' });
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
  return approveWithOneAdd(fx, plan.id, 'An MCP-planned card');
}

/** A card created directly — no plan ever shaped it. */
async function direct(fx: WorkItemFixture): Promise<Card> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Never planned' },
    fx.ctx,
  );
  return { id: item.id, key: item.identifier, planId: null };
}

/** A running dispatch run whose legs for `keys` are all OPEN (claimed). */
async function openLegs(fx: WorkItemFixture, keys: string[], ctx: ServiceContext) {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    ctx,
  );
  return run.id;
}

const report = (fx: WorkItemFixture, card: Card, ctx: ServiceContext, reason: string = REASON) =>
  runFoundReportService.reportUnbuildableTarget(
    { projectKey: fx.projectIdentifier, targetKey: card.key, reason },
    ctx,
  );

/** The report rows, events and meta-project bugs a card's report left behind. */
async function traces(card: Card, meta: Meta) {
  const legs = await adminDb.dispatchRunCard.findMany({ where: { workItemId: card.id } });
  const legIds = legs.map((l) => l.id);
  const rows = await adminDb.runFoundReport.findMany({
    where: { dispatchRunCardId: { in: legIds } },
  });
  const events = await adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunCardId: { in: legIds }, kind: 'unbuildable_reported' },
  });
  const bugs = await adminDb.workItem.findMany({
    where: { projectId: meta.fx.projectId, kind: 'bug' },
  });
  return { legIds, rows, events, bugs };
}

const eventData = (event: { data: unknown }) => event.data as Record<string, unknown>;

describe('the CLI-grant stand-in', () => {
  it('holds work_item:edit and NOT ai:view_plan — the gated verdict refuses it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    await expect(
      plansService.resolveApprovedShapeVerdict(fx.projectId, [card.id], cli),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('arm 1 — no open leg: nothing is written, nothing is filed', () => {
  it('a card with no running leg answers recordedOnRun: false and leaves no trace', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    const bugsBefore = (await traces(card, meta)).bugs.length;

    expect(await report(fx, card, cli)).toEqual(NOT_ON_RUN);

    expect(await adminDb.runFoundReport.count()).toBe(0);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'unbuildable_reported' } })).toBe(
      0,
    );
    expect((await traces(card, meta)).bugs).toHaveLength(bugsBefore);
  });

  it('a leg on a CLOSED run is not open — the same answer', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    const runId = await openLegs(fx, [card.key], cli);
    await dispatchRunService.close(runId, { stopReason: 'completed' }, cli);

    expect(await report(fx, card, cli)).toEqual(NOT_ON_RUN);
    const t = await traces(card, meta);
    expect(t.rows).toHaveLength(0);
    expect(t.events).toHaveLength(0);
    expect(t.bugs).toHaveLength(0);
  });
});

describe('the record-only arms — one row, one event on the leg, zero bugs', () => {
  it('no_plan — a card created directly', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await direct(fx);
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      outcome: 'no_plan',
      workspaceId: fx.workspaceId,
      filedWorkItemId: null,
      filedWorkItemIdentifier: null,
    });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.workspaceId).toBe(fx.workspaceId);
    expect(eventData(t.events[0]!)).toEqual({
      outcome: 'no_plan',
      verdict: 'no_plan',
      planId: null,
      proposalId: null,
      divergingRevisionId: null,
      authorSource: null,
      reason: REASON,
      dispatchRunCardId: t.legIds[0],
    });
    expect(t.bugs).toHaveLength(0);
  });

  it('not_native — a plan written through `create_plan` (mcp)', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await mcpBorn(fx);
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.rows.map((r) => r.outcome)).toEqual(['not_native']);
    expect(t.events).toHaveLength(1);
    expect(eventData(t.events[0]!)).toMatchObject({
      outcome: 'not_native',
      verdict: 'unchanged',
      planId: card.planId,
      authorSource: 'mcp',
    });
    expect(t.bugs).toHaveLength(0);
  });

  it('not_native — a plan with a NULL author source (before MOTIR-2996)', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, null);
    expect(
      (await adminDb.plan.findUniqueOrThrow({ where: { id: card.planId! } })).authorSource,
    ).toBeNull();
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.rows.map((r) => r.outcome)).toEqual(['not_native']);
    expect(t.events).toHaveLength(1);
    expect(eventData(t.events[0]!)).toMatchObject({ outcome: 'not_native', authorSource: null });
    expect(t.bugs).toHaveLength(0);
  });

  it('changed — a native plan whose card was edited after approval', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    await workItemsService.updateWorkItem(card.id, { descriptionMd: 'Rewritten.' }, fx.ctx);
    const gated = (await plansService.resolveApprovedShapeVerdict(fx.projectId, [card.id], fx.ctx))
      .items[0]!;
    expect(gated.divergingRevision).not.toBeNull();
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.rows.map((r) => r.outcome)).toEqual(['changed']);
    expect(t.events).toHaveLength(1);
    expect(eventData(t.events[0]!)).toMatchObject({
      outcome: 'changed',
      verdict: 'changed',
      planId: card.planId,
      proposalId: gated.proposalId,
      divergingRevisionId: gated.divergingRevision!.id,
      authorSource: 'native',
    });
    expect(t.bugs).toHaveLength(0);
  });
});

describe('arm 5 — native and unchanged: exactly ONE planning bug, in Motir’s planner-bug home', () => {
  it('from a CUSTOMER workspace, driven by the CLI grant: pointers only in the bug, the reason on the leg', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native', {
      planTitle: 'SENTINEL-PLAN-TITLE',
      title: 'SENTINEL-TARGET-TITLE',
    });
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.bugs).toHaveLength(1);
    const bug = t.bugs[0]!;
    // Filed by the system principal into the planner-bug FOLDER, not parented.
    const reporter = await adminDb.user.findUniqueOrThrow({ where: { id: bug.reporterId } });
    expect(reporter.email).toBe('system@motir.internal');
    expect(bug.workspaceId).toBe(meta.fx.workspaceId);
    expect(bug.folderId).toBe(meta.planningFolderId);
    expect(bug.parentId).toBeNull();
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      outcome: 'filed',
      filedWorkItemId: bug.id,
      filedWorkItemIdentifier: bug.identifier,
    });

    // The customer regime: no title, key, plan title or runner text crosses.
    const crossed = `${bug.title}\n${bug.descriptionMd ?? ''}`;
    for (const sentinel of [
      'SENTINEL-TARGET-TITLE',
      'SENTINEL-PLAN-TITLE',
      'SENTINEL-REASON',
      card.key,
    ]) {
      expect(crossed).not.toContain(sentinel);
    }
    expect(crossed).toContain(t.legIds[0]);
    expect(crossed).toContain(fx.workspaceId);

    // …and the reason stays verbatim on the leg, in the customer's tenant.
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.workspaceId).toBe(fx.workspaceId);
    expect(eventData(t.events[0]!)).toMatchObject({
      outcome: 'filed',
      verdict: 'unchanged',
      planId: card.planId,
      divergingRevisionId: null,
      authorSource: 'native',
      reason: REASON,
    });
  });

  it("from MOTIR's OWN workspace: the bug carries the reason verbatim", async () => {
    const meta = await makeMeta();
    const card = await planBorn(meta.fx, 'native', { planTitle: 'Own plan', title: 'Own card' });
    await openLegs(meta.fx, [card.key], meta.fx.ctx);
    const multiline = `${REASON}\nwith a \`\`\`fence\`\`\` inside`;

    expect(await report(meta.fx, card, meta.fx.ctx, multiline)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.bugs).toHaveLength(1);
    const bug = t.bugs[0]!;
    expect(bug.descriptionMd).toContain(multiline);
    expect(bug.descriptionMd).toContain(card.key);
    expect(bug.descriptionMd).toContain('Own plan');
    expect(bug.folderId).toBe(meta.planningFolderId);
    expect(t.rows[0]).toMatchObject({ outcome: 'filed', filedWorkItemIdentifier: bug.identifier });
  });

  it('an UNTITLED native plan still files — its title composes as empty', async () => {
    const meta = await makeMeta();
    const plan = await plansService.createPlan(
      meta.fx.projectId,
      { authorSource: 'native', authorHarness: 'Motir', authorModel: 'motir-planner' },
      meta.fx.ctx,
    );
    expect(plan.title ?? null).toBeNull();
    const card = await approveWithOneAdd(meta.fx, plan.id, 'Untitled-plan card');
    await openLegs(meta.fx, [card.key], meta.fx.ctx);

    expect(await report(meta.fx, card, meta.fx.ctx)).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.bugs).toHaveLength(1);
    expect(t.bugs[0]!.descriptionMd).toContain('- **Plan title:** \n');
  });

  it('with no system principal provisioned: the same acknowledgement, the row left undecided — and a later report files once', async () => {
    const meta = await makeMeta({ principal: false });
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    await openLegs(fx, [card.key], cli);

    expect(await report(fx, card, cli)).toEqual(ON_RUN);
    let t = await traces(card, meta);
    expect(t.bugs).toHaveLength(0);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.outcome).toBeNull();
    expect(eventData(t.events[0]!)).toMatchObject({
      outcome: null,
      verdict: 'unchanged',
      filingSkipped: 'no-system-principal',
    });

    await seedSystemPrincipal({ workspaceId: meta.fx.workspaceId, projectId: meta.fx.projectId });
    expect(await report(fx, card, cli)).toEqual(ON_RUN);
    t = await traces(card, meta);
    expect(t.bugs).toHaveLength(1);
    expect(t.rows.map((r) => r.outcome)).toEqual(['filed']);
    // The leg's event is once per leg — the first one stands.
    expect(t.events).toHaveLength(1);
  });
});

describe('idempotent per leg', () => {
  it('a RETRY returns an identical acknowledgement and leaves one row, one event, one bug', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    await openLegs(fx, [card.key], cli);

    const first = await report(fx, card, cli);
    const second = await report(fx, card, cli, 'a different reason the second time');

    expect(second).toEqual(first);
    const t = await traces(card, meta);
    expect(t.rows).toHaveLength(1);
    expect(t.events).toHaveLength(1);
    expect(eventData(t.events[0]!).reason).toBe(REASON);
    expect(t.bugs).toHaveLength(1);
  });

  it('two CONCURRENT reports on two real connections file exactly one bug', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    await openLegs(fx, [card.key], cli);
    // Warm the pool, so the two reports below get two already-open connections
    // and genuinely race rather than queue behind a connect.
    await Promise.all(
      Array.from({ length: 6 }, () =>
        workItemsService.getWorkItemByIdentifier(fx.projectId, card.key, fx.ctx),
      ),
    );

    const [a, b] = await Promise.all([report(fx, card, cli), report(fx, card, cli)]);

    expect(a).toEqual(ON_RUN);
    expect(b).toEqual(ON_RUN);
    const t = await traces(card, meta);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.outcome).toBe('filed');
    expect(t.events).toHaveLength(1);
    expect(t.bugs).toHaveLength(1);
  });
});

describe('the acknowledgement leaks nothing', () => {
  it('arms 2–5 answer deep-equal objects carrying no verdict, plan, outcome or key', async () => {
    await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const noPlan = await direct(fx);
    const notNative = await mcpBorn(fx);
    const changed = await planBorn(fx, 'native', { title: 'Changed later' });
    await workItemsService.updateWorkItem(changed.id, { descriptionMd: 'Edited.' }, fx.ctx);
    const filed = await planBorn(fx, 'native', { title: 'Filed' });
    await openLegs(fx, [noPlan.key, notNative.key, changed.key, filed.key], cli);

    const acks = [];
    for (const card of [noPlan, notNative, changed, filed]) acks.push(await report(fx, card, cli));

    const outcomes = await adminDb.runFoundReport.findMany({ select: { outcome: true } });
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(
      ['changed', 'filed', 'no_plan', 'not_native'].sort(),
    );
    for (const ack of acks) {
      expect(ack).toEqual(acks[0]);
      expect(Object.keys(ack).sort()).toEqual(['acknowledged', 'recordedOnRun']);
      const json = JSON.stringify(ack);
      for (const word of ['verdict', 'planId', 'outcome']) expect(json).not.toContain(word);
      expect(json).not.toMatch(/[A-Z][A-Z0-9]*-\d+/);
    }
  });
});

describe('permissions and input', () => {
  it('a caller who may browse but not edit the target is refused, and nothing is written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const reader = await memberWithRole(fx, 'Browse only', ['project:browse']);
    const card = await direct(fx);
    await openLegs(fx, [card.key], cli);

    await expect(report(fx, card, reader)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await adminDb.runFoundReport.count()).toBe(0);
  });

  it('a key in another workspace answers WorkItemNotFoundError — through either project key', async () => {
    const mine = await makeWorkItemFixture({ name: 'Mine', identifier: 'MINE' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THRS' });
    const card = await direct(theirs);

    for (const projectKey of [theirs.projectIdentifier, mine.projectIdentifier]) {
      await expect(
        runFoundReportService.reportUnbuildableTarget(
          { projectKey, targetKey: card.key, reason: REASON },
          mine.ctx,
        ),
      ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    }
  });

  it('an empty, blank or 4001-character reason answers RunFoundReportReasonInvalidError; 4000 is accepted', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await direct(fx);

    for (const reason of ['', '   \n\t ', 'x'.repeat(4001)]) {
      await expect(report(fx, card, fx.ctx, reason)).rejects.toBeInstanceOf(
        RunFoundReportReasonInvalidError,
      );
    }
    // Trimmed first: surrounding whitespace does not count toward the bound.
    expect(await report(fx, card, fx.ctx, `  ${'x'.repeat(4000)}  `)).toEqual(NOT_ON_RUN);
  });
});

// ── AMENDMENT 1 (MOTIR-8698) — the report reaches the server in every lane ─────────
//
// Rows 4–6 of the record's table: a hosted run's agent and an agent-instance run's
// agent hold no Motir token (`/api/mcp` refuses the run token), and a local agent may
// have no Motir MCP. The CLI makes the report instead, through
// `POST /api/v1/dispatch-runs/{id}/unbuildable`, with the RUN's credential. Row 2: a
// Motir-workspace plan written over the MCP (`plan.py`) files; a tenant's still does not.

/** A server-opened run over `card` — `hosted`, or `instance` naming an agent — with
 *  its leg OPEN, and the run's own bearer credential. */
async function serverRunOver(
  fx: WorkItemFixture,
  card: Card,
  origin: 'hosted' | 'instance',
): Promise<{ runId: string; headers: Record<string, string> }> {
  let agentInstanceId: string | null = null;
  if (origin === 'instance') {
    const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    const agent = await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: ws.organizationId,
        projectId: fx.projectId,
        ownerId: fx.ownerId,
        name: 'my-agent',
        profileId: 'claude-code',
        imageTag: 'latest',
        imageDigest: 'sha256:test',
        region: 'iad',
        state: 'running',
      },
    });
    agentInstanceId = agent.id;
  }
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      origin,
      agentInstanceId,
      createdById: fx.ownerId,
      cards: {
        create: [
          {
            workspaceId: fx.workspaceId,
            workItemId: card.id,
            workItemKey: card.key,
            position: 0,
            disposition: 'running',
            startedAt: new Date(),
          },
        ],
      },
    },
  });
  const { token } = await runCredentialService.mintRunCredential({
    dispatchRunId: run.id,
    dispatcherUserId: fx.ownerId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { runId: run.id, headers: bearer(token) };
}

async function postUnbuildable(
  runId: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/unbuildable/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/dispatch-runs/${runId}/unbuildable`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: runId }) },
  );
}

describe('AMENDMENT 1 — the run door, authenticated by the run’s own credential only', () => {
  it('the route is on the run-token list, bound to its own run, called by the CLI', () => {
    expect(RUN_TOKEN_ROUTES).toContainEqual({
      operationId: 'reportDispatchRunUnbuildable',
      method: 'POST',
      path: '/api/v1/dispatch-runs/{id}/unbuildable',
      binding: 'own_run',
      calledBy: 'cli',
    });
  });

  it.each(['hosted', 'instance'] as const)(
    'a %s run stopped on a native + unchanged CUSTOMER card files exactly ONE bug into Motir’s planner-bug home',
    async (origin) => {
      const meta = await makeMeta();
      const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
      const card = await planBorn(fx, 'native', { title: 'SENTINEL-TARGET-TITLE' });
      const tenantItemsBefore = await adminDb.workItem.count({
        where: { workspaceId: fx.workspaceId },
      });
      const { runId, headers } = await serverRunOver(fx, card, origin);

      const res = await postUnbuildable(runId, headers, { targetKey: card.key, reason: REASON });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ON_RUN);
      // A retry is the same acknowledgement and files nothing more.
      const again = await postUnbuildable(runId, headers, { targetKey: card.key, reason: REASON });
      expect(await again.json()).toEqual(ON_RUN);

      const t = await traces(card, meta);
      expect(t.bugs).toHaveLength(1);
      expect(t.bugs[0]!.workspaceId).toBe(meta.fx.workspaceId);
      expect(t.bugs[0]!.folderId).toBe(meta.planningFolderId);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]).toMatchObject({ outcome: 'filed', filedWorkItemId: t.bugs[0]!.id });
      // The customer regime is unchanged: pointers only cross.
      const crossed = `${t.bugs[0]!.title}\n${t.bugs[0]!.descriptionMd ?? ''}`;
      for (const sentinel of ['SENTINEL-TARGET-TITLE', 'SENTINEL-REASON', card.key]) {
        expect(crossed).not.toContain(sentinel);
      }
      // The finding is on THIS run's leg, in the tenant; nothing written into the
      // tenant's project.
      expect(t.events).toHaveLength(1);
      expect(t.events[0]!.dispatchRunId).toBe(runId);
      expect(t.events[0]!.workspaceId).toBe(fx.workspaceId);
      expect(eventData(t.events[0]!)).toMatchObject({ outcome: 'filed', reason: REASON });
      expect(await adminDb.workItem.count({ where: { workspaceId: fx.workspaceId } })).toBe(
        tenantItemsBefore,
      );
    },
  );

  it('a run token naming ANOTHER run is refused 403, and nothing is written', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await planBorn(fx, 'native');
    const other = await planBorn(fx, 'native', { title: 'Other card' });
    const mine = await serverRunOver(fx, card, 'hosted');
    const theirs = await serverRunOver(fx, other, 'hosted');

    const res = await postUnbuildable(theirs.runId, mine.headers, {
      targetKey: other.key,
      reason: REASON,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    expect((await traces(other, meta)).rows).toHaveLength(0);
    expect((await traces(other, meta)).bugs).toHaveLength(0);
  });

  it('a run token naming a card its run does not hold is refused, and nothing is written', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await planBorn(fx, 'native');
    const elsewhere = await planBorn(fx, 'native', { title: 'Not on this run' });
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    // The run token's `run_cards` binding refuses the card before the leg is read.
    const res = await postUnbuildable(runId, headers, { targetKey: elsewhere.key, reason: REASON });
    expect(res.status).toBe(403);
    const t = await traces(elsewhere, meta);
    expect(t.rows).toHaveLength(0);
    expect(t.bugs).toHaveLength(0);
  });

  it('the operator’s own credential naming a card the run does not hold is "not on the run"', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await planBorn(fx, 'native');
    const elsewhere = await planBorn(fx, 'native', { title: 'Not on this run' });
    const runId = await openLegs(fx, [card.key], fx.ctx);

    expect(
      await runFoundReportService.reportUnbuildableTargetForRun(
        runId,
        { targetKey: elsewhere.key, reason: REASON },
        fx.ctx,
      ),
    ).toEqual(NOT_ON_RUN);
    const t = await traces(elsewhere, meta);
    expect(t.rows).toHaveLength(0);
    expect(t.bugs).toHaveLength(0);
  });

  it('another member cannot report for a run they did not open', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await planBorn(fx, 'native');
    const runId = await openLegs(fx, [card.key], fx.ctx);

    await expect(
      runFoundReportService.reportUnbuildableTargetForRun(
        runId,
        { targetKey: card.key, reason: REASON },
        cli,
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
    expect((await traces(card, meta)).rows).toHaveLength(0);
  });

  it('a closed run is a 409, and a blank reason a 422 — neither writes', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const card = await planBorn(fx, 'native');
    const { runId, headers } = await serverRunOver(fx, card, 'hosted');

    const blank = await postUnbuildable(runId, headers, { targetKey: card.key, reason: '   ' });
    expect(blank.status).toBe(422);

    await adminDb.dispatchRun.update({
      where: { id: runId },
      data: { status: 'succeeded', endedAt: new Date() },
    });
    const closed = await postUnbuildable(runId, headers, { targetKey: card.key, reason: REASON });
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { code: string }).code).toBe('DISPATCH_RUN_TERMINAL');
    expect((await traces(card, meta)).rows).toHaveLength(0);
  });
});

describe('AMENDMENT 1 — row 2: Motir’s own MCP-written (plan.py) plans file; a tenant’s do not', () => {
  it('a CLI dispatch in MOTIR’s workspace, on a card an approved MCP plan shaped, files ONE bug through the run door', async () => {
    const meta = await makeMeta();
    const card = await mcpBorn(meta.fx);
    const runId = await openLegs(meta.fx, [card.key], meta.fx.ctx);

    expect(
      await runFoundReportService.reportUnbuildableTargetForRun(
        runId,
        { targetKey: card.key, reason: REASON },
        meta.fx.ctx,
      ),
    ).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.bugs).toHaveLength(1);
    expect(t.bugs[0]!.folderId).toBe(meta.planningFolderId);
    expect(t.bugs[0]!.descriptionMd).toContain(REASON);
    expect(t.rows[0]).toMatchObject({ outcome: 'filed' });
    expect(eventData(t.events[0]!)).toMatchObject({ outcome: 'filed', authorSource: 'mcp' });
  });

  it('the same MCP plan in a CUSTOMER workspace still files none — through either door', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: 'CUST' });
    const cli = await cliGrantMemberOf(fx);
    const card = await mcpBorn(fx);
    const runId = await openLegs(fx, [card.key], cli);

    expect(
      await runFoundReportService.reportUnbuildableTargetForRun(
        runId,
        { targetKey: card.key, reason: REASON },
        cli,
      ),
    ).toEqual(ON_RUN);

    const t = await traces(card, meta);
    expect(t.rows[0]).toMatchObject({ outcome: 'not_native' });
    expect(t.bugs).toHaveLength(0);
  });

  it('a MANUAL plan in Motir’s own workspace still files none', async () => {
    const meta = await makeMeta();
    const plan = await plansService.createPlan(
      meta.fx.projectId,
      { title: 'Hand plan', authorSource: 'manual' },
      meta.fx.ctx,
    );
    const card = await approveWithOneAdd(meta.fx, plan.id, 'Hand-planned card');
    await openLegs(meta.fx, [card.key], meta.fx.ctx);

    expect(await report(meta.fx, card, meta.fx.ctx)).toEqual(ON_RUN);
    const t = await traces(card, meta);
    expect(t.rows[0]).toMatchObject({ outcome: 'not_native' });
    expect(t.bugs).toHaveLength(0);
  });
});
