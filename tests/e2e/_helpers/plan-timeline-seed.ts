// The plan-TIMELINE E2E seed (Story MOTIR-3532 · Subtask MOTIR-3538).
//
// It composes `agent-authored-plan-seed.ts` rather than building a second
// substrate: that fixture already mints a real project-scoped token, opens a real
// MCP session over the real streamable-HTTP transport, and pins the reviewer's
// active project. What this story needs on top is a plan whose CONTENT moved —
// authored, deepened, and only THEN closed — because a timeline that never
// changed cannot show that it records change.
//
// ⚠️ THE EDIT IS DRIVEN OVER THE MCP, NOT THROUGH THE UI, and that is the
// product rather than a shortcut. `design/ai-planning/design-notes.md` Part V §3
// REMOVED the plan-review edit modal in favour of a read-only quick view, so a
// proposal is edited by the agent that wrote it — `update_plan_item`, the door
// `plansService.deepenProposal` backs. Driving a door the product does not have
// would be the spec asserting its own harness.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { adminDb } from './db-reset';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import type { PlanWithItemsDto } from '@/lib/dto/plans';

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const itemIds = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

export interface AuthoredWithEdits {
  planId: string;
  storyTitle: string;
  leafTitles: string[];
  /** The proposal the agent went back and deepened. */
  editedTitle: string;
}

/**
 * Author a plan the way a titles-first pass actually authors one — SKELETON,
 * DEEPEN, CLOSE — so the trail carries the shape the timeline was designed
 * against rather than a shape invented for the spec.
 *
 *   `create_plan` → `add_plan_items` (the story) → `add_plan_items` (its leaves)
 *   → `update_plan_item` ×2 (the deepen, while the plan is still `generating`)
 *   → `add_plan_items { final: true }` (the close).
 *
 * The two deepens are ADJACENT and by ONE actor, so the timeline folds them into
 * a single row with a span — which is the collapse rule meeting real data rather
 * than a fixture built to satisfy it.
 */
export async function authorPlanWithEdits(
  client: Client,
  projectKey: string,
  opts: { title: string; harness: string; model: string },
): Promise<AuthoredWithEdits> {
  const created = await client.callTool({
    name: CREATE_PLAN_TOOL_NAME,
    arguments: {
      projectKey,
      title: opts.title,
      summary: opts.title,
      plannedWithHarness: opts.harness,
      plannedWithModel: opts.model,
    },
  });
  const planId = struct(created as CallToolResult).id;

  const storyTitle = 'Seller payout schedules';
  const first = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: storyTitle, kind: 'story' } }],
    },
  })) as CallToolResult;

  const leafTitles = ['Nightly payout batch', 'Payout failure retries'];
  const leaves = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      proposals: leafTitles.map((title) => ({
        op: 'add',
        proposedFields: { title, kind: 'subtask', storyPoints: 3, estimateMinutes: 45 },
        parentRef: `planItem:${itemIds(first)[0]}`,
      })),
    },
  })) as CallToolResult;

  // THE DEEPEN — the act that is byte-invisible without this story. It merges
  // into `proposedFields` in place, so a proposal deepened twice is indis-
  // tinguishable from one written once unless something recorded that it moved.
  for (const [index, planItemId] of itemIds(leaves).entries()) {
    await client.callTool({
      name: UPDATE_PLAN_ITEM_TOOL_NAME,
      arguments: {
        planId,
        planItemId,
        descriptionMd: `Deepened body for leaf ${index + 1}.`,
        storyPoints: 5,
        estimateMinutes: 70,
      },
    });
  }

  // THE CLOSE — no proposals, `final: true`. It appends nothing, so it leaves no
  // content row; `markPlanned` writes the lifecycle one.
  await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: { planId, final: true, proposals: [] },
  });

  return { planId, storyTitle, leafTitles, editedTitle: leafTitles[0]! };
}

/**
 * Strip a plan's content trail, leaving exactly the state EVERY plan created
 * before MOTIR-3535 is in.
 *
 * ⚠️ It has to be done rather than found, and that is not a fixture convenience:
 * once the trail ships, every plan the seed creates HAS one, so the legacy state
 * cannot be reached by any sequence of product calls. Deleting the rows produces
 * the row-level state of a pre-existing plan exactly — the timeline reads the
 * table, and the table is empty for those plans.
 */
export async function stripContentTrail(planId: string): Promise<void> {
  await adminDb.planRevision.deleteMany({ where: { planId } });
}
