// Surgical-plan E2E seed (Story MOTIR-6013 · Subtask MOTIR-6058).
//
// The plans this spec reviews are AUTHORED THROUGH THE REAL MCP TOOLS, exactly as
// a planner writes them — `create_plan`, then `add_plan_items` — over the lane's
// own server with a minted project-scoped token (`agent-authored-plan-seed.ts`,
// whose header says why a stub proves nothing). The committed tree the plans act
// on rides the SHIPPED services, the one sanctioned cross-layer reach for setup.
//
// ⚠️ `baseURL` is Playwright's, passed in by the spec — never
// `process.env.MOTIR_BASE_URL`, which lives on the webServer env, not the runner.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  agentSession,
  seedAgentAuthoredPlan,
  type AgentPlanSeed,
} from './agent-authored-plan-seed';

export const REMOVE_REASON =
  'Replaced by the JSON export. Nothing has read the CSV since the importer moved.';
export const PROPOSED_STORY = 'Webhook delivery guarantees';
export const Z_TITLE = 'Retry schedule';
export const Z_RENAMED = 'Retry schedule with backoff';
export const Z_BODY = '## Acceptance criteria\n\n- A retry waits twice as long as the last.';

interface Card {
  id: string;
  identifier: string;
  title: string;
}

export interface SurgicalPlanSeed extends AgentPlanSeed {
  /** The epic S is proposed under, and its existing story. */
  e: Card;
  /** The epic holding X (moved) and Z (amended twice). */
  f: Card;
  fStory: Card;
  x: Card;
  z: Card;
  /** Removed WITH a reason. */
  y: Card;
  /** Removed with NO reason, on the second plan. */
  w: Card;
  /** The plan with all three shapes. */
  planId: string;
  /** A plan whose one `remove` carries no reason. */
  bareRemovePlanId: string;
  /** A plan forced into an illegal proposed parent, to be refused at approve. */
  illegalPlanId: string;
  illegalCard: Card;
}

async function card(
  seed: AgentPlanSeed,
  title: string,
  kind: 'epic' | 'story' | 'task',
  parentId?: string,
): Promise<Card> {
  const ctx: ServiceContext = { userId: seed.userId, workspaceId: seed.workspaceId };
  const dto = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    ctx,
  );
  return { id: dto.id, identifier: dto.identifier, title };
}

const planOf = (r: unknown) =>
  (r as CallToolResult).structuredContent as unknown as PlanWithItemsDto;
const idsOf = (r: unknown) =>
  ((r as CallToolResult).structuredContent as unknown as { planItemIds: string[] }).planItemIds;

/** One `add_plan_items` call; a tool-level refusal fails the seed loudly. */
async function append(
  client: Client,
  planId: string,
  proposals: unknown[],
  final = false,
): Promise<string[]> {
  const result = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: { planId, proposals, ...(final ? { final: true } : {}) },
  })) as CallToolResult;
  if (result.isError) throw new Error(`add_plan_items refused: ${JSON.stringify(result.content)}`);
  return idsOf(result);
}

async function createPlan(client: Client, projectKey: string, title: string): Promise<string> {
  return planOf(
    await client.callTool({
      name: CREATE_PLAN_TOOL_NAME,
      arguments: { projectKey, title, summary: title, plannedWithHarness: 'Claude Code' },
    }),
  ).id;
}

export async function seedSurgicalPlan(email: string, baseURL: string): Promise<SurgicalPlanSeed> {
  const seed = await seedAgentAuthoredPlan(email);
  const e = await card(seed, 'Webhooks', 'epic');
  await card(seed, 'Webhook signing', 'story', e.id);
  const f = await card(seed, 'Billing', 'epic');
  const fStory = await card(seed, 'Invoices', 'story', f.id);
  const x = await card(seed, 'Retry a failed delivery', 'task', fStory.id);
  const z = await card(seed, Z_TITLE, 'task', fStory.id);
  const y = await card(seed, 'Legacy CSV export', 'task', fStory.id);
  const w = await card(seed, 'Old usage report', 'task', fStory.id);
  const illegalCard = await card(seed, 'Dunning emails', 'task', fStory.id);

  const client = await agentSession(seed.token, baseURL);
  try {
    // ── The plan a reviewer accepts the story from ─────────────────────────
    const planId = await createPlan(client, seed.projectKey, 'Move delivery retries to webhooks');
    const [s] = await append(client, planId, [
      { op: 'add', parentRef: e.id, proposedFields: { title: PROPOSED_STORY, kind: 'story' } },
    ]);
    await append(client, planId, [
      { op: 'modify', workItemId: x.id, patch: { parentRef: `planItem:${s}` } },
      { op: 'modify', workItemId: z.id, patch: { title: Z_RENAMED } },
    ]);
    // The SECOND modify of Z — it merges into the one above.
    await append(
      client,
      planId,
      [
        { op: 'modify', workItemId: z.id, patch: { descriptionMd: Z_BODY } },
        { op: 'remove', workItemId: y.id, reason: REMOVE_REASON },
      ],
      true,
    );

    // ── A remove with NO reason ────────────────────────────────────────────
    const bareRemovePlanId = await createPlan(client, seed.projectKey, 'Retire the usage report');
    await append(client, bareRemovePlanId, [{ op: 'remove', workItemId: w.id }], true);

    // ── A move whose proposed parent is made ILLEGAL after the append ───────
    // Every door re-runs the gate (append, correction), so the illegal state
    // is written underneath them — the seed's sanctioned reach — to show that
    // approve re-takes the verdict rather than trusting the append.
    const illegalPlanId = await createPlan(client, seed.projectKey, 'Move dunning under a story');
    const [story] = await append(client, illegalPlanId, [
      { op: 'add', parentRef: f.id, proposedFields: { title: 'Dunning', kind: 'story' } },
    ]);
    await append(
      client,
      illegalPlanId,
      [{ op: 'modify', workItemId: illegalCard.id, patch: { parentRef: `planItem:${story}` } }],
      true,
    );
    // A task may not hang under a task: the proposed story becomes one.
    await db.planItem.update({
      where: { id: story! },
      data: { proposedFields: { title: 'Dunning', kind: 'task' } },
    });

    return {
      ...seed,
      e,
      f,
      fStory,
      x,
      z,
      y,
      w,
      planId,
      bareRemovePlanId,
      illegalPlanId,
      illegalCard,
    };
  } finally {
    await client.close();
  }
}
