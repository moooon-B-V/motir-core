import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { GET_APPROVED_SHAPE_VERDICT_TOOL_NAME } from '@/lib/mcp/tools/getApprovedShapeVerdict';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { WorkItemApprovedShapeVerdictDto, WorkItemPlanHistoryPageDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_approved_shape_verdict` (Story MOTIR-5544 · Subtask MOTIR-6227) — the
// RUNBOOK's door onto the approved-shape verdict, over a real Postgres and the
// real MCP transport.
//
// The tool is a TRANSPORT: the verdict and the change predicate are
// `plansService.resolveApprovedShapeVerdict` and `lib/plans/approvedShapeChange.ts`,
// proven in `tests/integration/plans/approvedShapeVerdict.test.ts`. What is
// asserted HERE is what only the door can answer — the schema an agent sees,
// that each verdict arrives through it intact, its refusal set, and its
// permission contract (including the deliberate CLI-token refusal).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

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

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'get-approved-shape-verdict', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function ask(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({
    name: GET_APPROVED_SHAPE_VERDICT_TOOL_NAME,
    arguments: args,
  })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

type KeyedVerdict = WorkItemApprovedShapeVerdictDto & { key: string };
type Payload = KeyedVerdict & {
  planHistory: WorkItemPlanHistoryPageDto;
  children: KeyedVerdict[];
};
const payloadOf = (r: CallToolResult) => r.structuredContent as unknown as Payload;

/** A plan carrying `proposals`, driven through the real service to approval. */
async function approvedPlan(
  fx: WorkItemFixture,
  proposals: Parameters<typeof plansService.addProposals>[1],
  title = 'The plan',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return plan.id;
}

/** The card an approved plan's `add` titled `title` materialized. */
async function cardOf(planId: string, title: string) {
  const rows = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  const row = rows.find((r) => (r.proposedFields as { title?: string } | null)?.title === title);
  if (!row?.workItemId) throw new Error(`no materialized add titled ${title}`);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: row.workItemId } });
}

/** A leaf born of an approved plan. */
async function planBorn(fx: WorkItemFixture) {
  const planId = await approvedPlan(fx, [
    { op: 'add', proposedFields: { title: 'Born', kind: 'task' } },
  ]);
  return { planId, card: await cardOf(planId, 'Born') };
}

/** A story and two subtasks, all born of ONE approved plan. */
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
    story: await cardOf(plan.id, 'Story'),
    one: await cardOf(plan.id, 'One'),
    two: await cardOf(plan.id, 'Two'),
  };
}

/** A project member whose role does not hold `ai:view_plan`. */
async function viewerOf(fx: WorkItemFixture): Promise<ServiceContext> {
  const user = await createTestUser({ name: 'Viewer' });
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

describe('registered, permissioned, documented (criteria 1, 6, 8, 9)', () => {
  it('is in the registry, and every declaration home carries it', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_APPROVED_SHAPE_VERDICT_TOOL_NAME]).toBe('ai:view_plan');
    expect(TOOL_SCOPES[GET_APPROVED_SHAPE_VERDICT_TOOL_NAME]).toBe('work_items:write');
    expect(EXEMPT_TOOLS).toHaveProperty(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME);
    expect(read('design/mcp-server/build.py')).toContain(
      `"${GET_APPROVED_SHAPE_VERDICT_TOOL_NAME}":`,
    );
  });

  it('docs/mcp.md carries its section, with the CHANGE definition in both directions', () => {
    const doc = read('docs/mcp.md');
    const start = doc.indexOf(`#### \`${GET_APPROVED_SHAPE_VERDICT_TOOL_NAME}\``);
    expect(start).toBeGreaterThan(doc.indexOf('#### `get_plan`'));
    const section = doc.slice(start, doc.indexOf('\n#### ', start + 1));
    expect(section).toContain('THE CHANGE DEFINITION');
    expect(section).toMatch(/\*\*Counts:\*\*/);
    expect(section).toMatch(/\*\*Does not count:\*\*/);
    expect(section).toContain('status transitions');
    expect(section).toContain('`no_plan` is an ANSWER');
  });

  it('is NOT billable — a read starts no model job', () => {
    expect(isBillableTool(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME)).toBe(false);
  });

  it('a CLI-minted token is REFUSED — asserted off the constant, naming the key', () => {
    // Built from `CLI_TOKEN_GRANT` itself, never an inline list: widening that
    // array to carry `ai:view_plan` fails HERE. A dispatched agent is not this
    // tool's caller (`docs/decisions/run-findings-protocol.md` Q3).
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    const denial = permissionDenial(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, [...CLI_TOKEN_GRANT]);
    expect(denial).not.toBeNull();
    const text = textOf(denial!);
    expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text).toContain('ai:view_plan');
    expect(text).toContain(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME);
    // …and the gate opens for a token that holds the key.
    expect(permissionDenial(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, ['ai:view_plan'])).toBeNull();
  });

  it('the tool module makes no Prisma call of its own', () => {
    const source = read('lib/mcp/tools/getApprovedShapeVerdict.ts');
    expect(source).not.toMatch(/prisma\./);
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/lib\/repositories\//);
  });

  it('tools/list returns it with `key` required and `childKeys` an optional array', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === GET_APPROVED_SHAPE_VERDICT_TOOL_NAME)!;
    expect(tool).toBeDefined();

    const schema = tool.inputSchema as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['key']);
    expect(schema.properties['key']?.type).toBe('string');
    expect(schema.properties['childKeys']?.type).toBe('array');

    // The description states what an agent branches on.
    for (const verdict of ['`unchanged`', '`changed`', '`no_plan`']) {
      expect(tool.description).toContain(verdict);
    }
    expect(tool.description).toMatch(/`no_plan` IS AN ANSWER/);
    expect(tool.description).toContain('WHAT COUNTS AS A CHANGE');
    expect(tool.description).toContain('WHAT DOES NOT');
    expect(tool.description).toMatch(/PURE READ, safe to repeat/);
    expect(tool.description).toContain('APPROVED_SHAPE_NOT_A_CHILD');
  });
});

describe('each verdict arrives through the door (criteria 2, 3, 4)', () => {
  it('a card an approved plan created, untouched → unchanged, with its history and the plan', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const client = await connectClient(fx.ctx);

    const res = await ask(client, { key: born.card.identifier.toLowerCase() });

    expect(res.isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p).toMatchObject({
      key: born.card.identifier,
      workItemId: born.card.id,
      verdict: 'unchanged',
      planId: born.planId,
      planTitle: 'The plan',
      divergingRevision: null,
      childSet: null,
    });
    expect(p.planHistory.items.map((e) => [e.planId, e.planStatus, e.relation.op])).toEqual([
      [born.planId, 'approved', 'add'],
    ]);
    expect(p.children).toEqual([]);
    expect(textOf(res)).toContain(`${born.card.identifier}: unchanged`);
  });

  it('a card edited after approval → changed, naming the diverging revision', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const decidedAt = (await adminDb.plan.findUniqueOrThrow({ where: { id: born.planId } }))
      .decidedAt!;
    await workItemsService.updateWorkItem(born.card.id, { descriptionMd: 'Rewritten.' }, fx.ctx);
    const edit = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: born.card.id, changedAt: { gt: decidedAt } },
    });
    const client = await connectClient(fx.ctx);

    const res = await ask(client, { key: born.card.identifier });

    expect(res.isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p.verdict).toBe('changed');
    expect(p.planId).toBe(born.planId);
    expect(p.divergingRevision).toMatchObject({ id: edit.id, changeKind: 'updated' });
    expect(p.divergingRevision!.changedKeys).toContain('descriptionMd');
    expect(textOf(res)).toContain(edit.id);
  });

  it('a card no plan ever shaped → no_plan with a null plan id, as a SUCCESS', async () => {
    const fx = await makeWorkItemFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Hand-made' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    const res = await ask(client, { key: card.identifier });

    expect(res.isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p).toMatchObject({ verdict: 'no_plan', planId: null, planTitle: null });
    expect(p.planHistory).toEqual({ items: [], nextCursor: null });
  });

  it('files, transitions and creates nothing', async () => {
    const fx = await makeWorkItemFixture();
    const born = await planBorn(fx);
    const before = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });
    const client = await connectClient(fx.ctx);

    await ask(client, { key: born.card.identifier });

    expect(await adminDb.workItem.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

describe('childKeys (criterion 5)', () => {
  it('returns the container’s own verdict plus one per child key, in the order given', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);
    // Change ONE child after approval, so the per-child answers differ.
    await workItemsService.updateWorkItem(t.two.id, { title: 'Two, renamed' }, fx.ctx);
    const client = await connectClient(fx.ctx);

    const res = await ask(client, {
      key: t.story.identifier,
      childKeys: [t.two.identifier, t.one.identifier],
    });

    expect(res.isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p).toMatchObject({ key: t.story.identifier, verdict: 'unchanged', planId: t.planId });
    expect(p.childSet).toMatchObject({ verdict: 'unchanged', added: [], removed: [] });
    expect(p.children.map((c) => [c.key, c.workItemId, c.verdict])).toEqual([
      [t.two.identifier, t.two.id, 'changed'],
      [t.one.identifier, t.one.id, 'unchanged'],
    ]);
  });

  it('a key that is NOT a child of `key` is REFUSED by name — not dropped, not answered', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);
    const stranger = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Elsewhere' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);

    for (const wrong of [stranger.identifier, t.story.identifier]) {
      const res = await ask(client, {
        key: t.story.identifier,
        childKeys: [t.one.identifier, wrong],
      });
      expect(res.isError, wrong).toBe(true);
      expect(res.structuredContent).toBeUndefined();
      const text = textOf(res);
      expect(text).toMatch(/^APPROVED_SHAPE_NOT_A_CHILD: /);
      expect(text).toContain(`${wrong} is not a child of ${t.story.identifier}`);
    }
  });
});

describe('the permission refusal (criterion 6)', () => {
  it('a member without ai:view_plan is refused NAMING THE KEY — not an empty history, not no_plan', async () => {
    const fx = await makeWorkItemFixture();
    const t = await planBornStory(fx);
    const stranger = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Elsewhere' },
      fx.ctx,
    );
    const client = await connectClient(await viewerOf(fx));

    const res = await ask(client, { key: t.story.identifier });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(textOf(res)).toMatch(/^PERMISSION_DENIED: .*"ai:view_plan"/);

    // The permission is refused BEFORE any child key is judged, so the order
    // of the errors leaks nothing about the container's children.
    const withBadChild = await ask(client, {
      key: t.story.identifier,
      childKeys: [stranger.identifier],
    });
    expect(textOf(withBadChild)).toMatch(/^PERMISSION_DENIED: /);
  });
});

describe('not-found without an existence leak (criterion 7)', () => {
  it('a real key in another workspace and an unknown one answer the SAME error', async () => {
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const theirs = await planBorn(other);
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const client = await connectClient(fx.ctx);

    const real = await ask(client, { key: theirs.card.identifier });
    const unknown = await ask(client, { key: 'ZZZ-99999' });

    expect(real.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(textOf(real)).toBe(textOf(unknown));
    expect(textOf(real)).toMatch(/^PROJECT_NOT_FOUND: /);
    expect(JSON.stringify(real)).not.toContain(theirs.card.id);
    expect(JSON.stringify(real)).not.toContain(theirs.planId);
  });

  it('an unknown key in the caller’s own project is a plain not-found', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const res = await ask(client, { key: `${fx.projectIdentifier}-99999` });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^WORK_ITEM_NOT_FOUND: /);
  });

  it('an unknown or foreign CHILD key is the same not-found, never a verdict', async () => {
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const theirs = await planBorn(other);
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const t = await planBornStory(fx);
    const client = await connectClient(fx.ctx);

    const real = await ask(client, {
      key: t.story.identifier,
      childKeys: [theirs.card.identifier],
    });
    const unknown = await ask(client, { key: t.story.identifier, childKeys: ['ZZZ-99999'] });
    expect(textOf(real)).toBe(textOf(unknown));
    expect(textOf(real)).toMatch(/^PROJECT_NOT_FOUND: /);
  });
});
