import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { GET_APPROVED_SHAPE_VERDICT_TOOL_NAME } from '@/lib/mcp/tools/getApprovedShapeVerdict';
import { REPORT_UNBUILDABLE_TARGET_TOOL_NAME } from '@/lib/mcp/tools/reportUnbuildableTarget';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { DEFAULT_BUG_FOLDER_NAME } from '@/lib/projects/bugDestination';
import type { WorkItemApprovedShapeVerdictDto, WorkItemPlanHistoryPageDto } from '@/lib/dto/plans';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { foldersService } from '@/lib/services/foldersService';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { mcpRouteFetch } from '../../helpers/mcpRouteFetch';

// THE STORY GATE (Story MOTIR-5544 · Subtask MOTIR-6232) — the ASSEMBLED
// motir-core half of trigger 2, over the REAL Postgres, driven only through the
// doors an agent really holds.
//
// Each card below it proved its own side with the neighbouring seam mocked or
// driven by a service call. What is asserted HERE is the chain between them:
//
//   * THE VERDICT — every edit is made through a real MCP write tool
//     (`transition_status`, `update_work_item`, `create_work_item`), and the
//     answer is read back through `get_approved_shape_verdict`. So the revision
//     the verdict walks is the one the TOOL's path wrote, not one a test inserted
//     or a service call shaped.
//   * THE REPORT — every arm is driven through `report_unbuildable_target` on the
//     REAL `/api/mcp` route, with a bearer minted from EXACTLY `CLI_TOKEN_GRANT`,
//     the credential a dispatched runner holds. An RLS or permission denial on
//     the leg read would surface as "no open leg"; the open-leg arms below prove
//     the runner's credential FINDS its leg, and each arm counts the row, the
//     leg's event and the planning-bug folder rather than trusting the answer.
//
// The per-card specs this does NOT repeat: `approvedShapeVerdict` /
// `approvedShapeForReport` (the service arms), `get-approved-shape-verdict` and
// `report-unbuildable-target` (each door's schema, refusals and declarations),
// `runFoundReportService` (the service arms, concurrency, no principal).

const ENDPOINT = 'http://localhost/api/mcp';
const REASON = 'GATE-REASON: the card names a table `run_found_ledger` that does not exist.';
const CUSTOMER_KEY = 'CUST';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Transport ─────────────────────────────────────────────────────────────────

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return result;
}

/** Call a tool that must succeed; return its structured payload. */
async function ok<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(client, name, args);
  expect(result.isError, `${name}: ${textOf(result)}`).toBeFalsy();
  return result.structuredContent as T;
}

/** An in-process MCP client for a full-access member (the verdict half). */
async function memberClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'run-found-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** A client on the REAL route, authenticated by a token minted from EXACTLY `CLI_TOKEN_GRANT`. */
async function cliClient(fx: WorkItemFixture): Promise<Client> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'run-found-story-gate',
    fixedGrant: [...CLI_TOKEN_GRANT],
  });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'run-found-story-gate-cli', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

type Proposals = Parameters<typeof plansService.addProposals>[1];

/** A plan carrying `proposals`, driven through the real service to a decision. */
async function decidedPlan(
  fx: WorkItemFixture,
  proposals: Proposals,
  decision: 'approved' | 'declined' | 'planned',
  input: Parameters<typeof plansService.createPlan>[1] = { title: 'A plan' },
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, input, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  if (decision === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else if (decision === 'declined') await plansService.declinePlan(plan.id, fx.ctx);
  // A plan left `planned` holds its targets; release them so a later plan may
  // name the same card (the `approvedShapeVerdict` spec's `decidedPlan` shape).
  else await adminDb.planTargetLock.deleteMany({ where: { planId: plan.id } });
  return plan.id;
}

interface Born {
  planId: string;
  proposalId: string;
  id: string;
  key: string;
  decidedAt: Date;
}

/** The card an approved plan's `add` titled `title` materialized, with its proposal. */
async function bornOf(planId: string, title: string): Promise<Born> {
  const rows = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const row = rows.find((r) => (r.proposedFields as { title?: string } | null)?.title === title);
  if (!row?.workItemId) throw new Error(`no materialized add titled ${title} on ${planId}`);
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId } });
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  return {
    planId,
    proposalId: row.id,
    id: item.id,
    key: item.identifier,
    decidedAt: plan.decidedAt!,
  };
}

/** A leaf born of one approved plan (native when asked — motir-ai's author triple). */
async function planBorn(
  fx: WorkItemFixture,
  opts: { native?: boolean; title?: string } = {},
): Promise<Born> {
  const title = opts.title ?? 'Born';
  const planId = await decidedPlan(
    fx,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    'approved',
    opts.native
      ? {
          title: 'A native plan',
          authorSource: 'native',
          authorHarness: 'Motir',
          authorModel: 'motir-planner',
        }
      : { title: 'A plan' },
  );
  return bornOf(planId, title);
}

/** The revisions a card carries strictly after `after`, oldest first. */
const revisionsAfter = (workItemId: string, after: Date) =>
  adminDb.workItemRevision.findMany({
    where: { workItemId, changedAt: { gt: after } },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
  });

/** A status the card may legally move to from where it rests. */
async function legalNextStatus(id: string): Promise<string> {
  const item = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return item.status === 'in_progress' ? 'todo' : 'in_progress';
}

type KeyedVerdict = WorkItemApprovedShapeVerdictDto & { key: string };
type VerdictPayload = KeyedVerdict & {
  planHistory: WorkItemPlanHistoryPageDto;
  children: KeyedVerdict[];
};

const verdictOf = (client: Client, key: string, childKeys?: string[]) =>
  ok<VerdictPayload>(client, GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, {
    key,
    ...(childKeys ? { childKeys } : {}),
  });

// ═════════════════════════════════════════════════════════════════════════════
// 1 · THE VERDICT — edits through the real write tools, read through the verdict tool
// ═════════════════════════════════════════════════════════════════════════════

describe('the verdict, end to end through the MCP tools (criterion 2)', () => {
  it('unchanged: an approved plan’s card, never touched — the plan id and the add’s proposal id', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const client = await memberClient(fx.ctx);

    const v = await verdictOf(client, born.key);

    expect(v).toMatchObject({
      key: born.key,
      workItemId: born.id,
      verdict: 'unchanged',
      planId: born.planId,
      proposalId: born.proposalId,
      decidedAt: born.decidedAt.toISOString(),
      divergingRevision: null,
      childSet: null,
    });
    // The approving plan is the one the history door names — one read, two doors.
    expect(v.planHistory.items.map((e) => [e.planId, e.planStatus, e.proposalIds.self])).toEqual([
      [born.planId, 'approved', born.proposalId],
    ]);
    await client.close();
  });

  it('a real `transition_status` call and nothing else → still unchanged, over the revision it wrote', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const client = await memberClient(fx.ctx);
    const to = await legalNextStatus(born.id);

    await ok(client, 'transition_status', { key: born.key, status: to });

    // The tool's path really wrote ONE revision after the decision, and it is a
    // status cell — the verdict below read past a real row, not an absent one.
    const after = await revisionsAfter(born.id, born.decidedAt);
    expect(after).toHaveLength(1);
    expect(after[0]!.changeKind).toBe('updated');
    expect(Object.keys(after[0]!.diff as object)).toEqual(['status']);
    expect(after[0]!.diff).toMatchObject({ status: { to } });

    expect(await verdictOf(client, born.key)).toMatchObject({
      verdict: 'unchanged',
      planId: born.planId,
      proposalId: born.proposalId,
      divergingRevision: null,
    });
    await client.close();
  });

  it('a real `update_work_item` of descriptionMd → changed, naming that revision, its changedAt and changedKeys', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const client = await memberClient(fx.ctx);

    await ok(client, 'transition_status', {
      key: born.key,
      status: await legalNextStatus(born.id),
    });
    await ok(client, 'update_work_item', { key: born.key, descriptionMd: 'Rewritten by hand.' });

    const after = await revisionsAfter(born.id, born.decidedAt);
    const edit = after.find((r) => 'descriptionMd' in (r.diff as object));
    expect(edit, 'update_work_item wrote a descriptionMd revision').toBeDefined();

    const v = await verdictOf(client, born.key);
    expect(v.verdict).toBe('changed');
    expect(v.planId).toBe(born.planId);
    expect(v.divergingRevision).toEqual({
      id: edit!.id,
      changedAt: edit!.changedAt.toISOString(),
      changedById: fx.ownerId,
      changeKind: 'updated',
      changedKeys: Object.keys(edit!.diff as object),
    });
    expect(v.divergingRevision!.changedKeys).toContain('descriptionMd');
    await client.close();
  });

  it('two shape-changing `update_work_item` calls in order → divergingRevision is the EARLIER one', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const client = await memberClient(fx.ctx);

    await ok(client, 'update_work_item', { key: born.key, title: 'Renamed first' });
    await ok(client, 'update_work_item', { key: born.key, descriptionMd: 'Then rewritten.' });

    const after = await revisionsAfter(born.id, born.decidedAt);
    expect(after.map((r) => Object.keys(r.diff as object))).toEqual([['title'], ['descriptionMd']]);

    const v = await verdictOf(client, born.key);
    expect(v.verdict).toBe('changed');
    expect(v.divergingRevision).toMatchObject({
      id: after[0]!.id,
      changedAt: after[0]!.changedAt.toISOString(),
      changedKeys: ['title'],
    });
    await client.close();
  });

  it('no_plan: a card made by `create_work_item`, and one whose only plans are declined and planned', async () => {
    const fx = await makeWorkItemFixture();
    const client = await memberClient(fx.ctx);

    const direct = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
      projectKey: fx.projectIdentifier,
      kind: 'task',
      title: 'Hand-made',
    });
    expect(await verdictOf(client, direct.identifier)).toMatchObject({
      verdict: 'no_plan',
      planId: null,
      proposalId: null,
      divergingRevision: null,
      childSet: null,
      planHistory: { items: [], nextCursor: null },
    });

    const touched = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
      projectKey: fx.projectIdentifier,
      kind: 'task',
      title: 'Planned at, never approved',
    });
    await decidedPlan(
      fx,
      [{ op: 'modify', workItemId: touched.id, patch: { title: 'X' } }],
      'declined',
    );
    await decidedPlan(
      fx,
      [{ op: 'modify', workItemId: touched.id, patch: { title: 'Y' } }],
      'planned',
    );

    const v = await verdictOf(client, touched.identifier);
    // The history is NOT empty — the verdict looked at real plans and found no
    // approved one among them.
    expect(v.planHistory.items.map((e) => e.planStatus)).toEqual(['declined', 'planned']);
    expect(v).toMatchObject({ verdict: 'no_plan', planId: null, proposalId: null });
    await client.close();
  });

  describe('a container and the children a parent run found wrong', () => {
    /** A story and two subtasks, all born of ONE approved plan (temp-ref parents). */
    async function planBornStory(fx: WorkItemFixture) {
      const plan = await plansService.createPlan(fx.projectId, { title: 'Story plan' }, fx.ctx);
      const first = await plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'Story', kind: 'story' } }],
        fx.ctx,
      );
      const storyAdd = first.items.find((i) => i.proposedFields?.title === 'Story')!;
      await plansService.addProposals(
        plan.id,
        ['One', 'Two'].map((title) => ({
          op: 'add' as const,
          proposedFields: { title, kind: 'subtask' as const },
          parentRef: `${TEMP_REF_PREFIX}${storyAdd.id}`,
        })),
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await plansService.approvePlan(plan.id, fx.ctx);
      return {
        planId: plan.id,
        story: await bornOf(plan.id, 'Story'),
        one: await bornOf(plan.id, 'One'),
        two: await bornOf(plan.id, 'Two'),
      };
    }

    it('one verdict per id plus the container’s own; a child added by `create_work_item` makes the container changed', async () => {
      const fx = await makeWorkItemFixture();
      const t = await planBornStory(fx);
      const client = await memberClient(fx.ctx);

      // Untouched: the container and each child answer unchanged, per id, in the
      // order given — a key repeated is answered once.
      const before = await verdictOf(client, t.story.key, [t.two.key, t.one.key, t.two.key]);
      expect([before.key, before.verdict, before.proposalId]).toEqual([
        t.story.key,
        'unchanged',
        t.story.proposalId,
      ]);
      expect(before.childSet).toMatchObject({ verdict: 'unchanged', added: [], removed: [] });
      expect(before.children.map((c) => [c.key, c.verdict, c.proposalId])).toEqual([
        [t.two.key, 'unchanged', t.two.proposalId],
        [t.one.key, 'unchanged', t.one.proposalId],
      ]);

      // A child the plan never approved, added through the real write tool, and a
      // shape edit on ONE approved child.
      const extra = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
        projectKey: fx.projectIdentifier,
        kind: 'subtask',
        title: 'Added after approval',
        parentKey: t.story.key,
      });
      await ok(client, 'update_work_item', { key: t.one.key, descriptionMd: 'Reworded.' });

      const after = await verdictOf(client, t.story.key, [t.one.key, t.two.key, extra.identifier]);
      // The container is changed by its CHILD SET alone — no revision of its own.
      expect(after).toMatchObject({
        verdict: 'changed',
        divergingRevision: null,
        planId: t.planId,
      });
      expect(after.childSet).toEqual({
        verdict: 'changed',
        approvedChildIds: [t.one.id, t.two.id].sort(),
        currentChildIds: [t.one.id, t.two.id, extra.id].sort(),
        added: [extra.id],
        removed: [],
      });
      // …and each child is judged on its own log.
      expect(after.children.map((c) => [c.key, c.verdict])).toEqual([
        [t.one.key, 'changed'],
        [t.two.key, 'unchanged'],
        [extra.identifier, 'no_plan'],
      ]);
      expect(after.children[0]!.divergingRevision!.changedKeys).toContain('descriptionMd');
      await client.close();
    });

    it('a plan that only ADDED a child under a hand-made story: the container reads that plan, and a later child changes it', async () => {
      const fx = await makeWorkItemFixture();
      const client = await memberClient(fx.ctx);
      const story = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
        projectKey: fx.projectIdentifier,
        kind: 'story',
        title: 'Hand-made story',
      });
      // An UNTITLED plan — the door must still name it.
      const planId = await decidedPlan(
        fx,
        [
          {
            op: 'add',
            proposedFields: { title: 'Planned child', kind: 'subtask' },
            parentRef: story.id,
          },
        ],
        'approved',
        {},
      );
      const child = await bornOf(planId, 'Planned child');

      const res = await call(client, GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, {
        key: story.identifier,
      });
      expect(res.isError, textOf(res)).toBeFalsy();
      const v = res.structuredContent as unknown as VerdictPayload;
      // The plan did not target the story itself — it only added under it.
      expect(v).toMatchObject({ verdict: 'unchanged', planId, planTitle: null, proposalId: null });
      expect(v.planHistory.items[0]!.relation).toMatchObject({ op: null, childCount: 1 });
      expect(textOf(res)).toContain('1 child add(s)');

      const late = await ok<{ id: string }>(client, 'create_work_item', {
        projectKey: fx.projectIdentifier,
        kind: 'subtask',
        title: 'Late child',
        parentKey: story.identifier,
      });
      const changed = await call(client, GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, {
        key: story.identifier,
      });
      const p = changed.structuredContent as unknown as VerdictPayload;
      expect(p).toMatchObject({ verdict: 'changed', divergingRevision: null });
      expect(p.childSet).toMatchObject({ added: [late.id], removed: [] });
      expect(p.childSet!.approvedChildIds).toEqual([child.id]);
      expect(textOf(changed)).toContain('child set — 1 added, 0 removed since approval');
      await client.close();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2 · THE REPORT — one case per arm, through /api/mcp with a CLI_TOKEN_GRANT token
// ═════════════════════════════════════════════════════════════════════════════

interface Meta {
  fx: WorkItemFixture;
  planningFolderId: string;
  principalUserId: string;
}

/** Motir's own tenant: the meta project, its `Bugs / Planning bugs` folder as the
 *  planner-bug destination, and the system principal — the seed's shape. */
async function makeMeta(): Promise<Meta> {
  const fx = await makeWorkItemFixture({ name: 'moooon', identifier: 'MOTIR' });
  // Project creation seeds the root `Bugs` folder (`DEFAULT_BUG_FOLDER_NAME`);
  // the planner-bug home is `Planning bugs` beneath it, as on the live tenant.
  const bugs = await adminDb.folder.findFirstOrThrow({
    where: { projectId: fx.projectId, parentFolderId: null, name: DEFAULT_BUG_FOLDER_NAME },
  });
  const planning = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: bugs.id, name: 'Planning bugs' },
    fx.ctx,
  );
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { plannerBugDestinationFolderId: planning.id },
  });
  const { userId } = await seedSystemPrincipal({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
  });
  return { fx, planningFolderId: planning.id, principalUserId: userId };
}

/** A running dispatch run whose legs for `keys` are OPEN (claimed). */
async function openLegs(fx: WorkItemFixture, keys: string[]): Promise<void> {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    keys.map((key) => ({
      kind: 'card_claimed' as const,
      workItemKey: key,
      disposition: 'running' as const,
    })),
    fx.ctx,
  );
}

const reportThrough = (client: Client, targetKey: string) =>
  call(client, REPORT_UNBUILDABLE_TARGET_TOOL_NAME, {
    projectKey: CUSTOMER_KEY,
    targetKey,
    reason: REASON,
  });

/** What one card's report left behind: its filing rows, its leg events, the meta bugs. */
async function traces(workItemId: string, meta: Meta) {
  const legs = await adminDb.dispatchRunCard.findMany({ where: { workItemId } });
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

const dataOf = (event: { data: unknown }) => event.data as Record<string, unknown>;

/** Assert the answer is the acknowledgement and nothing else; return it. */
function acknowledgementOf(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, textOf(result)).toBeFalsy();
  const ack = result.structuredContent as Record<string, unknown>;
  expect(Object.keys(ack).sort()).toEqual(['acknowledged', 'recordedOnRun']);
  return ack;
}

describe('the report, one case per arm, on /api/mcp with a CLI_TOKEN_GRANT token (criteria 3, 4)', () => {
  it('the runner’s credential cannot read the verdict over the same endpoint — ai:view_plan is refused', async () => {
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: CUSTOMER_KEY });
    const born = await planBorn(fx);
    const client = await cliClient(fx);

    const res = await call(client, GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, { key: born.key });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(textOf(res)).toContain('ai:view_plan');
    expect(res.structuredContent).toBeUndefined();
    await client.close();
  });

  it('every arm, and a retry: row / event / bug counted per arm, and the four leg acks deep-equal', async () => {
    const meta = await makeMeta();
    const fx = await makeWorkItemFixture({ name: 'Customer', identifier: CUSTOMER_KEY });
    const client = await cliClient(fx);

    // ── The five targets, each shaped through a real door ─────────────────────
    // No open leg: a card no run is working.
    const idle = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
      projectKey: CUSTOMER_KEY,
      kind: 'task',
      title: 'Not on any run',
    });
    // no_plan: created directly, through the runner's own credential.
    const noPlan = await ok<{ id: string; identifier: string }>(client, 'create_work_item', {
      projectKey: CUSTOMER_KEY,
      kind: 'task',
      title: 'Never planned',
    });
    // not_native: a plan written through `create_plan` (the MCP door writes
    // `authorSource: mcp`), approved, card untouched — so ONLY the author decides.
    const created = await ok<{ id: string }>(client, 'create_plan', {
      projectKey: CUSTOMER_KEY,
      title: 'An MCP plan',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5-5',
    });
    const mcpPlan = await adminDb.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(mcpPlan.authorSource).toBe('mcp');
    await plansService.addProposals(
      mcpPlan.id,
      [{ op: 'add', proposedFields: { title: 'MCP-planned card', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(mcpPlan.id, fx.ctx);
    await plansService.approvePlan(mcpPlan.id, fx.ctx);
    const notNative = await bornOf(mcpPlan.id, 'MCP-planned card');
    // changed: a NATIVE plan's card, hand-edited after approval through the
    // runner's own `update_work_item`.
    const edited = await planBorn(fx, { native: true, title: 'Edited after approval' });
    await ok(client, 'update_work_item', { key: edited.key, descriptionMd: 'Hand-edited.' });
    const [editRevision] = await revisionsAfter(edited.id, edited.decidedAt);
    // native + unchanged: the one arm that files.
    const files = await planBorn(fx, { native: true, title: 'Native and untouched' });

    await openLegs(fx, [noPlan.identifier, notNative.key, edited.key, files.key]);

    // ── No open leg ──────────────────────────────────────────────────────────
    const idleAck = acknowledgementOf(await reportThrough(client, idle.identifier));
    expect(idleAck).toStrictEqual({ acknowledged: true, recordedOnRun: false });
    const idleTraces = await traces(idle.id, meta);
    expect(idleTraces.legIds).toEqual([]);
    expect(await adminDb.runFoundReport.count()).toBe(0);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'unbuildable_reported' } })).toBe(
      0,
    );
    expect(idleTraces.bugs).toHaveLength(0);

    // ── no_plan ──────────────────────────────────────────────────────────────
    const noPlanAck = acknowledgementOf(await reportThrough(client, noPlan.identifier));
    const noPlanTraces = await traces(noPlan.id, meta);
    expect(noPlanTraces.rows.map((r) => r.outcome)).toEqual(['no_plan']);
    expect(noPlanTraces.rows[0]!.filedWorkItemId).toBeNull();
    expect(noPlanTraces.events).toHaveLength(1);
    expect(dataOf(noPlanTraces.events[0]!)).toMatchObject({
      outcome: 'no_plan',
      verdict: 'no_plan',
      planId: null,
      reason: REASON,
    });
    expect(noPlanTraces.bugs).toHaveLength(0);

    // ── Non-native author ────────────────────────────────────────────────────
    const notNativeAck = acknowledgementOf(await reportThrough(client, notNative.key));
    const notNativeTraces = await traces(notNative.id, meta);
    expect(notNativeTraces.rows.map((r) => r.outcome)).toEqual(['not_native']);
    expect(notNativeTraces.events).toHaveLength(1);
    expect(dataOf(notNativeTraces.events[0]!)).toMatchObject({
      outcome: 'not_native',
      verdict: 'unchanged',
      planId: mcpPlan.id,
      authorSource: 'mcp',
      reason: REASON,
    });
    expect(notNativeTraces.bugs).toHaveLength(0);

    // ── changed ──────────────────────────────────────────────────────────────
    const changedAck = acknowledgementOf(await reportThrough(client, edited.key));
    const changedTraces = await traces(edited.id, meta);
    expect(changedTraces.rows.map((r) => r.outcome)).toEqual(['changed']);
    expect(changedTraces.events).toHaveLength(1);
    expect(dataOf(changedTraces.events[0]!)).toMatchObject({
      outcome: 'changed',
      verdict: 'changed',
      planId: edited.planId,
      authorSource: 'native',
      // The event names the revision the runner's own edit wrote.
      divergingRevisionId: editRevision!.id,
      reason: REASON,
    });
    expect(changedTraces.bugs).toHaveLength(0);

    // ── Native and unchanged — EXACTLY ONE bug, in Bugs / Planning bugs ──────
    const filedAck = acknowledgementOf(await reportThrough(client, files.key));
    const filedTraces = await traces(files.id, meta);
    expect(filedTraces.rows.map((r) => r.outcome)).toEqual(['filed']);
    expect(filedTraces.bugs).toHaveLength(1);
    const bug = filedTraces.bugs[0]!;
    expect(bug.folderId).toBe(meta.planningFolderId);
    expect(bug.parentId).toBeNull();
    expect(bug.reporterId).toBe(meta.principalUserId);
    expect(filedTraces.rows[0]).toMatchObject({
      filedWorkItemId: bug.id,
      filedWorkItemIdentifier: bug.identifier,
    });
    expect(filedTraces.events).toHaveLength(1);
    expect(dataOf(filedTraces.events[0]!)).toMatchObject({
      outcome: 'filed',
      verdict: 'unchanged',
      planId: files.planId,
      proposalId: files.proposalId,
      authorSource: 'native',
      divergingRevisionId: null,
      reason: REASON,
    });
    // The event lives in the CALLER's tenant; the bug in Motir's.
    expect(filedTraces.events[0]!.workspaceId).toBe(fx.workspaceId);
    expect(bug.workspaceId).toBe(meta.fx.workspaceId);

    // ── A retried call on that same leg ───────────────────────────────────────
    const retry = await reportThrough(client, files.key);
    const retryAck = acknowledgementOf(retry);
    expect(retryAck).toStrictEqual(filedAck);
    const afterRetry = await traces(files.id, meta);
    expect(afterRetry.rows).toHaveLength(1);
    expect(afterRetry.rows[0]!.outcome).toBe('filed');
    expect(afterRetry.events).toHaveLength(1);
    expect(afterRetry.bugs.map((b) => b.id)).toEqual([bug.id]);

    // ── The four leg-arm acknowledgements are deep-equal, and carry nothing ──
    for (const ack of [noPlanAck, notNativeAck, changedAck, retryAck]) {
      expect(ack).toStrictEqual(filedAck);
    }
    expect(filedAck).toStrictEqual({ acknowledged: true, recordedOnRun: true });
    const serialized = JSON.stringify([noPlanAck, notNativeAck, changedAck, filedAck, retryAck]);
    for (const leak of [
      bug.id,
      bug.identifier,
      files.planId,
      mcpPlan.id,
      edited.planId,
      editRevision!.id,
      'no_plan',
      'not_native',
      'changed',
      'unchanged',
      'filed',
      'verdict',
    ]) {
      expect(serialized, `the acknowledgement leaks ${leak}`).not.toContain(leak);
    }

    // Across every arm: one bug, and one row + one event per leg that reported.
    expect(await adminDb.runFoundReport.count()).toBe(4);
    expect(await adminDb.dispatchRunEvent.count({ where: { kind: 'unbuildable_reported' } })).toBe(
      4,
    );
    expect(
      await adminDb.workItem.count({ where: { projectId: meta.fx.projectId, kind: 'bug' } }),
    ).toBe(1);
    await client.close();
  });
});
