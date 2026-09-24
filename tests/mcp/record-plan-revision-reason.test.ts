import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  RECORD_PLAN_REVISION_REASON_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { REASON_CLASSIFIED_KIND, REVISION_REASON_EVIDENCE_MAX } from '@/lib/plans/revisionReason';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `record_plan_revision_reason` (Story MOTIR-5543 · MOTIR-6086) — the RUNBOOK's
// door onto the internal classification record.
//
// The tool is THIN: the branch/bug agreement, the key resolution, the lock, the
// frozen-status gate and the trail write are all
// `plansService.recordRevisionClassification`, and
// `tests/integration/plans/recordRevisionClassification.test.ts` proves them
// there. What is asserted HERE is what only the transport can answer:
//
//   1. THE TOOL EXISTS AND REACHES THE SERVICE — through the real MCP transport,
//      with a real argument schema, not a direct service call.
//   2. ⚠️ THE PERMISSION CONTRACT, IN BOTH DIRECTIONS, and the REFUSAL is the
//      half that matters. A token built from `CLI_TOKEN_GRANT` must be DENIED,
//      and the assertion is built from that CONSTANT rather than an inline list:
//      classifying a revision is part of revising a plan, so a later widening of
//      the grant fails HERE rather than quietly handing a sandboxed run a way to
//      annotate a plan it may not revise.
//   3. THE KEY IS RESOLVED — `planningBugKey` is what the runbook holds after
//      `create_work_item`, and the id is what the row stores. That translation
//      is this door's own, so it is asserted at this door.
//   4. THE DESCRIPTION STATES THE CONTRACT an agent plans against, including the
//      two things it cannot guess: that the rule branches are decided by a
//      SEARCH, and that this tool changes nothing about the plan.
//   5. NOTHING BECOMES A WORK ITEM, and nothing about the plan moves.

beforeEach(async () => {
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
  const client = new Client({ name: 'record-plan-revision-reason', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A CLOSED plan carrying two proposals — the state a reviewer asks to change. */
async function plannedPlan(client: Client, fx: WorkItemFixture): Promise<string> {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'The surface',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The picker', kind: 'story' } }],
  });
  await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
  return planId;
}

/** A real planning bug in the fixture's project, as the runbook files one. */
async function planningBug(fx: WorkItemFixture) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Planning bug: the check nobody made' },
    fx.ctx,
  );
}

const classifications = (planId: string) =>
  adminDb.planRevision.findMany({
    where: { planId, changeKind: REASON_CLASSIFIED_KIND },
    orderBy: { changedAt: 'asc' },
  });

describe('the tool is registered, permissioned and free', () => {
  it('is in the registry and declared in TOOL_PERMISSIONS', () => {
    expect(MCP_TOOL_NAMES).toContain(RECORD_PLAN_REVISION_REASON_TOOL_NAME);
    expect(TOOL_PERMISSIONS[RECORD_PLAN_REVISION_REASON_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('the gate opens with the key and closes without it', () => {
    const withoutIt = GRANTABLE_PERMISSIONS.filter(
      (p) => p !== TOOL_PERMISSIONS[RECORD_PLAN_REVISION_REASON_TOOL_NAME],
    );
    expect(permissionDenial(RECORD_PLAN_REVISION_REASON_TOOL_NAME, withoutIt)).not.toBeNull();
    expect(
      permissionDenial(RECORD_PLAN_REVISION_REASON_TOOL_NAME, GRANTABLE_PERMISSIONS),
    ).toBeNull();
  });

  it('is NOT billable — recording a judgement starts no model job', () => {
    expect(isBillableTool(RECORD_PLAN_REVISION_REASON_TOOL_NAME)).toBe(false);
  });

  it('a CLI-minted token is REFUSED, and the refusal names the missing key', () => {
    // Built from the CONSTANT, never from an inline list. The rule this pins is
    // the card's own: a run that may not REVISE a plan should not be able to
    // ANNOTATE one either, so widening `CLI_TOKEN_GRANT` later fails here.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    const denial = permissionDenial(RECORD_PLAN_REVISION_REASON_TOOL_NAME, [...CLI_TOKEN_GRANT]);
    expect(denial).not.toBeNull();
    const text = textOf(denial!);
    expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text).toContain('ai:view_plan');
    expect(text).toContain(RECORD_PLAN_REVISION_REASON_TOOL_NAME);
  });

  it('its description states the contract an agent plans against', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === RECORD_PLAN_REVISION_REASON_TOOL_NAME)!;

    // All four branch names, since the whole tool is a choice between them.
    for (const branch of ['new_ask', 'different_solution', 'rule_gap', 'rule_not_followed']) {
      expect(tool.description).toContain(branch);
    }
    // The status boundary — the half a caller would otherwise discover by being
    // refused.
    expect(tool.description).toContain('generating');
    expect(tool.description).toContain('planned');
    expect(tool.description).toContain('approved');
    // ⚠️ AND THE TWO HALVES NOBODY CAN GUESS.
    // That the rule branches are settled by a SEARCH and not by a feeling —
    // without it an agent asserts a gap it never looked for, which is exactly
    // the unverified negative the card forbids.
    expect(tool.description).toMatch(/SEARCH AND NOT A\s+JUDGEMENT/i);
    // And that calling it changes NOTHING about the plan, with a correction door
    // named — otherwise an agent reads it as one of the five tools that do.
    expect(tool.description).toMatch(/CHANGES NOTHING/);
    expect(tool.description).toContain(UPDATE_PLAN_PROPOSAL_TOOL_NAME);
  });
});

describe('driven through the real transport with a workspace PAT', () => {
  it.each([
    ['new_ask', false],
    ['different_solution', false],
    ['rule_gap', true],
    ['rule_not_followed', true],
  ] as const)('records `%s` and resolves the bug KEY to its id', async (branch, filesABug) => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);
    const bug = filesABug ? await planningBug(fx) : null;

    const res = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch,
      evidenceMd: 'Searched the rule corpus and the lesson store; nothing asks for it.',
      ...(bug ? { planningBugKey: bug.identifier } : {}),
    });

    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as unknown as {
      kind: string;
      branch: string;
      planningBugKey: string | null;
      revisionId: string;
      at: string;
    };
    expect(payload.kind).toBe(REASON_CLASSIFIED_KIND);
    expect(payload.branch).toBe(branch);
    expect(payload.planningBugKey).toBe(bug?.identifier ?? null);

    const rows = await classifications(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(payload.revisionId);
    // ⚠️ THE KEY WAS RESOLVED TO AN ID. The runbook holds a key; the row stores
    // an id, and that translation is this door's own.
    expect(rows[0]!.diff).toEqual({ branch, planningBugId: bug?.id ?? null });
    expect(rows[0]!.noteMd).toBe(
      'Searched the rule corpus and the lesson store; nothing asks for it.',
    );
    // The time reported is the ROW's, not the moment the tool was called.
    expect(payload.at).toBe(rows[0]!.changedAt.toISOString());
  });

  it('records on a `generating` plan too, and NOTHING about the plan moves', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'Still open',
    });
    const planId = (created.structuredContent as unknown as { id: string }).id;
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'A card', kind: 'story' } }],
    });
    const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: 'They asked for CSV export mid-generation; nothing raised it before.',
    });

    expect(await classifications(planId)).toHaveLength(1);
    // The plan is untouched: same status, same proposal set, same headings.
    const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.status).toBe(before.status);
    expect(after.title).toBe(before.title);
    expect(after.summary).toBe(before.summary);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('creates NO work item — the bug is the caller’s to file', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);
    const bug = await planningBug(fx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'rule_gap',
      evidenceMd: 'No rule asks for it.',
      planningBugKey: bug.identifier,
    });

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('the no-bug branches SAY the judgement is on the record, not merely that nothing was filed', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);

    const res = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'different_solution',
      evidenceMd: 'They prefer a side panel; the modal answered the question asked.',
    });

    // The prose matters here: an agent that reads "no bug filed" and nothing else
    // learns the wrong lesson — that this branch is a no-op.
    expect(textOf(res)).toMatch(/ON THE RECORD/);
  });
});

describe('the refusals a caller can hit through the transport', () => {
  it('REFUSES a branch outside the vocabulary at the SCHEMA, before any service call', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);

    const res = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'because_i_said_so',
      evidenceMd: 'e',
    });

    expect(res.isError).toBe(true);
    expect(await classifications(planId)).toHaveLength(0);
  });

  it('REFUSES a rule branch with no key, and a no-bug branch carrying one', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);
    const bug = await planningBug(fx);

    const missing = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'rule_gap',
      evidenceMd: 'No rule asks for it.',
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('PLAN_REVISION_CLASSIFICATION_INVALID');

    const stray = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: 'Nobody raised it.',
      planningBugKey: bug.identifier,
    });
    expect(stray.isError).toBe(true);

    expect(await classifications(planId)).toHaveLength(0);
  });

  it('REFUSES a key that names no work item, and one that is not a `bug`', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A task, not a bug' },
      fx.ctx,
    );

    const unknown = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'rule_gap',
      evidenceMd: 'No rule asks for it.',
      planningBugKey: 'PROD-99999',
    });
    expect(unknown.isError).toBe(true);

    const notABug = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'rule_not_followed',
      evidenceMd: 'The pack required it.',
      planningBugKey: task.identifier,
    });
    expect(notABug.isError).toBe(true);
    expect(textOf(notABug)).toContain('task');

    expect(await classifications(planId)).toHaveLength(0);
  });

  it('REFUSES empty evidence and evidence past its bound', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const planId = await plannedPlan(client, fx);

    const empty = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: '   ',
    });
    expect(empty.isError).toBe(true);

    const tooLong = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
      planId,
      branch: 'new_ask',
      evidenceMd: 'x'.repeat(REVISION_REASON_EVIDENCE_MAX + 1),
    });
    expect(tooLong.isError).toBe(true);

    expect(await classifications(planId)).toHaveLength(0);
  });

  it.each(['approved', 'declined'] as const)(
    'REFUSES on a `%s` plan, naming the status',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const planId = await plannedPlan(client, fx);
      await adminDb.plan.update({ where: { id: planId }, data: { status } });

      const res = await call(client, RECORD_PLAN_REVISION_REASON_TOOL_NAME, {
        planId,
        branch: 'new_ask',
        evidenceMd: 'Too late.',
      });

      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain('PLAN_NOT_EDITABLE');
      expect(text).toContain(status);
      expect(await classifications(planId)).toHaveLength(0);
    },
  );
});
