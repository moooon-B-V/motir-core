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
  REPORT_PLAN_STEP_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `report_plan_step` (Story MOTIR-7820 · Subtask MOTIR-7824) — the MCP planner's
// door onto the plan's in-flight STEPS.
//
// The tool is THIN: the grant, the `generating` guard, the target rules and the
// clock are all `plansService.recordPlanStep` / `endPlanStep`, and
// `tests/integration/plans/planSteps.test.ts` proves them there. What is asserted
// HERE is what only the transport can answer:
//
//   1. THE TOOL EXISTS, through the real MCP transport with its real schema, and
//      what it writes is what the plan review read (`GET /api/plans/[id]`'s
//      `planReviewService.getPlanReview`) hands back as `inFlightSteps`.
//   2. THE UNTARGETED FORMS PASS THE DOOR — `lay` and `author` with no `target`.
//      A door that demanded one would refuse the two moments both walks have.
//   3. A KEY-FORM target is resolved to the work item's id at this door.
//   4. EVERY REFUSAL IS A TYPED TOOL ERROR — `PLAN_NOT_GENERATING` off
//      `generating`, `PLAN_STEP_INVALID` on a bad step — never an internal error,
//      because the signal is advisory and a planner must be able to carry on.
//   5. ⚠️ THE PERMISSION CONTRACT, asserted off `CLI_TOKEN_GRANT` itself: a
//      `motir run` credential may not report progress on a plan.

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
  const client = new Client({ name: 'report-plan-step', version: '0.0.0' });
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

interface StepPayload {
  planId: string;
  sessionKey: string;
  step: string;
  targetRef: string | null;
  startedAt: string | null;
}

/** A plan still being WRITTEN, carrying one `add` — the state a walk reports on. */
async function generatingPlan(
  client: Client,
  fx: WorkItemFixture,
): Promise<{ planId: string; addId: string }> {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'Being written',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;
  const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The picker', kind: 'story' } }],
  });
  const addId = (appended.structuredContent as unknown as { planItemIds: string[] })
    .planItemIds[0]!;
  return { planId, addId };
}

const review = (planId: string, fx: WorkItemFixture) =>
  planReviewService.getPlanReview(planId, fx.ctx);

describe('the tool is registered, permissioned and free', () => {
  it('is in the registry and declared in TOOL_PERMISSIONS as `ai:view_plan`', () => {
    expect(MCP_TOOL_NAMES).toContain(REPORT_PLAN_STEP_TOOL_NAME);
    expect(TOOL_PERMISSIONS[REPORT_PLAN_STEP_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('a token without `ai:view_plan` is refused at the gate, before any write', () => {
    const withoutIt = GRANTABLE_PERMISSIONS.filter((p) => p !== 'ai:view_plan');
    expect(permissionDenial(REPORT_PLAN_STEP_TOOL_NAME, withoutIt)).not.toBeNull();
    expect(permissionDenial(REPORT_PLAN_STEP_TOOL_NAME, GRANTABLE_PERMISSIONS)).toBeNull();
  });

  it('is NOT billable — a progress signal starts no model job', () => {
    expect(isBillableTool(REPORT_PLAN_STEP_TOOL_NAME)).toBe(false);
  });

  it('a CLI-minted token is REFUSED, asserted off the constant', () => {
    // Built from `CLI_TOKEN_GRANT` itself: widening it later fails HERE rather
    // than quietly letting a `motir run` report progress on a plan.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');
    const denial = permissionDenial(REPORT_PLAN_STEP_TOOL_NAME, [...CLI_TOKEN_GRANT]);
    expect(denial).not.toBeNull();
    const text = textOf(denial!);
    expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text).toContain('ai:view_plan');
  });

  it('`tools/list` publishes the four steps and an OPTIONAL target', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === REPORT_PLAN_STEP_TOOL_NAME)!;
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: string[]; maxLength?: number; minLength?: number }>;
      required?: string[];
    };

    expect(schema.properties['step']!.enum).toEqual(['settle', 'lay', 'author', 'end']);
    expect(schema.properties['sessionKey']!.minLength).toBe(1);
    expect(schema.properties['sessionKey']!.maxLength).toBe(128);
    expect(schema.properties).toHaveProperty('target');
    expect(schema.required).toEqual(expect.arrayContaining(['planId', 'sessionKey', 'step']));
    expect(schema.required).not.toContain('target');
    // The two things a planner would otherwise learn by being refused.
    expect(tool.description).toContain('generating');
    expect(tool.description).toMatch(/ADVISORY/);
    expect(tool.annotations?.idempotentHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });
});

describe('driven through the real transport with a workspace PAT', () => {
  it('records each step and the review read returns it; `end` clears it', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, addId } = await generatingPlan(client, fx);

    const settle = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'settle',
      step: 'settle',
    });
    expect(settle.isError).toBeFalsy();

    const author = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-1',
      step: 'author',
      target: `planItem:${addId}`,
    });
    expect(author.isError).toBeFalsy();
    const payload = author.structuredContent as unknown as StepPayload;
    expect(payload).toMatchObject({
      planId,
      sessionKey: 'author-1',
      step: 'author',
      targetRef: `planItem:${addId}`,
    });

    const live = await review(planId, fx);
    expect(live.inFlightSteps).toHaveLength(2);
    const authored = live.inFlightSteps!.find((s) => s.sessionKey === 'author-1')!;
    expect(authored).toMatchObject({ kind: 'author', targetRef: `planItem:${addId}` });
    // ⚠️ THE ROW'S TIME, NOT THE CALL'S — the door reports what was stored.
    expect(payload.startedAt).toBe(authored.startedAt);

    const lay = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'lay-1',
      step: 'lay',
      target: `planItem:${addId}`,
    });
    expect(lay.isError).toBeFalsy();

    const ended = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-1',
      step: 'end',
    });
    expect(ended.isError).toBeFalsy();
    expect(ended.structuredContent).toEqual({
      planId,
      sessionKey: 'author-1',
      step: 'end',
      targetRef: null,
      startedAt: null,
    });

    const after = await review(planId, fx);
    expect(after.inFlightSteps!.map((s) => s.sessionKey).sort()).toEqual(['lay-1', 'settle']);

    // `end` again is a no-op SUCCESS — a planner clearing on every exit cannot fail.
    const again = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'author-1',
      step: 'end',
    });
    expect(again.isError).toBeFalsy();
  });

  it('a second report under one `sessionKey` REPLACES the first', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, addId } = await generatingPlan(client, fx);

    await call(client, REPORT_PLAN_STEP_TOOL_NAME, { planId, sessionKey: 's', step: 'settle' });
    await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's',
      step: 'author',
      target: `planItem:${addId}`,
    });

    const live = await review(planId, fx);
    expect(live.inFlightSteps).toHaveLength(1);
    expect(live.inFlightSteps![0]).toMatchObject({ sessionKey: 's', kind: 'author' });
  });

  it.each(['lay', 'author'] as const)(
    'accepts `%s` with NO target, stored as `targetRef: null`',
    async (step) => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const { planId } = await generatingPlan(client, fx);

      const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
        planId,
        sessionKey: `untargeted-${step}`,
        step,
      });
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as unknown as StepPayload).targetRef).toBeNull();

      const live = await review(planId, fx);
      expect(live.inFlightSteps).toEqual([
        expect.objectContaining({ sessionKey: `untargeted-${step}`, kind: step, targetRef: null }),
      ]);
    },
  );

  it('resolves a KEY-form target to the work item’s id', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await generatingPlan(client, fx);
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Committed parent' },
      fx.ctx,
    );

    const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 'lay-key',
      step: 'lay',
      target: item.identifier,
    });

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as unknown as StepPayload).targetRef).toBe(item.id);
    const live = await review(planId, fx);
    expect(live.inFlightSteps![0]!.targetRef).toBe(item.id);
  });
});

describe('the refusals arrive as typed tool errors, never an internal error', () => {
  it.each(['planned', 'approved', 'declined'] as const)(
    'refuses a `%s` plan with PLAN_NOT_GENERATING and changes nothing',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const client = await connectClient(fx.ctx);
      const { planId } = await generatingPlan(client, fx);
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      const before = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });

      for (const step of ['lay', 'end'] as const) {
        const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
          planId,
          sessionKey: 'late',
          step,
        });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain('PLAN_NOT_GENERATING');
      }

      expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
      const after = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(after.lastActivityAt.toISOString()).toBe(before.lastActivityAt.toISOString());
    },
  );

  it('refuses an invalid step with PLAN_STEP_INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, addId } = await generatingPlan(client, fx);

    const cases: Record<string, unknown>[] = [
      { step: 'settle', target: `planItem:${addId}` },
      { step: 'end', target: `planItem:${addId}` },
      { step: 'author', target: 'planItem:does-not-exist' },
      { step: 'lay', target: 'folder:anything' },
      { step: 'lay', target: 'PROD-999999' },
    ];
    for (const extra of cases) {
      const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
        planId,
        sessionKey: 'bad',
        ...extra,
      });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(textOf(res), JSON.stringify(extra)).toContain('PLAN_STEP_INVALID');
    }
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });

  it('refuses a step outside the vocabulary at the SCHEMA', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId } = await generatingPlan(client, fx);

    const res = await call(client, REPORT_PLAN_STEP_TOOL_NAME, {
      planId,
      sessionKey: 's',
      step: 'daydream',
    });
    expect(res.isError).toBe(true);
    expect(await adminDb.planStep.count({ where: { planId } })).toBe(0);
  });
});
