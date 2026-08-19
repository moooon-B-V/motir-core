import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { planValidityService } from '@/lib/services/planValidityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { PlanValidityDto } from '@/lib/dto/plans';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { conditionField } from './sprintRef';
import { requiredPlanIdField } from './planRef';

// `validate_plan` (Story MOTIR-3093 · Subtask MOTIR-3095) — is the WHOLE plan
// finishable once it materializes? The PAT-reachable twin of
// `POST /api/internal/ai/validate-plan-forest`, which `motir-ai`'s
// `generate_tree` runs as its PRE-COMMIT post-condition before closing a plan.
// The check, its rules and its tests all shipped with MOTIR-1550; what this adds
// is a door, so an agent authoring a plan over the MCP can run the same check
// its Motir-native counterpart already runs.
//
// ── Why this is its OWN tool and not a `planId` on `validate_work_item` ──────
// The forest verdict takes NO TARGET. Its containing set S is the entire
// projected forest, which is exactly what makes it the right question: a
// `blocked_by` edge that crosses two sibling roots (a story under proposed epic
// B gated by one under proposed epic A) is SATISFIED — both materialize
// together, so the gating node IS in S. Iterating the single-subtree check per
// root FALSE-POSITIVES every one of those edges, which is why
// `validate-plan-forest`'s own header calls a per-root walk "worse than no
// validation" for the multi-root forest a generation emits. Do not reimplement
// this as a loop over `validate_work_item`.
//
// A thin READ adapter over `planValidityService.validateProjectedPlan` — no
// business logic here. `project:browse` (`lib/mcp/toolPermissions.ts`), the key
// its own service asserts through `plansService.getPlan`, and NOT `ai:view_plan`
// (which gates the plan DECISIONS — approve / decline / addProposals). A
// projection decides nothing, writes nothing, persists nothing:
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q8.

export const VALIDATE_PLAN_TOOL_NAME = 'validate_plan';

const inputSchema = {
  planId: requiredPlanIdField,
  condition: conditionField,
};

interface ValidatePlanArgs {
  planId: string;
  condition?: ValidityCondition;
}

/** Human-readable summary for the dual-content text block. */
function summarize(result: PlanValidityDto): string {
  if (result.valid) {
    return (
      `Plan ${result.planId} is VALID — every item in the projected forest can be finished ` +
      'once this plan materializes. No work item was created: approving the plan in Motir is ' +
      'still the only path from a proposal to a work item.'
    );
  }
  return [
    `Plan ${result.planId} is INVALID — ${result.blockers.length} item(s) in the projected ` +
      'forest are gated by work that is neither in the plan nor done:',
    ...result.blockers.map(
      (b) =>
        `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
        `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
    ),
    'Fix each edge before `final: true` — that is the only moment this check is cheap. An item ' +
      'named `planItem:<id>` is a proposal in THIS plan, not a work item.',
  ].join('\n');
}

export async function runValidatePlan(
  args: ValidatePlanArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    // The plan is read through `plansService.getPlan`, which resolves the
    // project AND asserts browse on it — so there is no project argument to
    // take and no second access check to add here.
    const result = await planValidityService.validateProjectedPlan(
      args.planId,
      ctx,
      args.condition,
    );
    return toolOk(
      summarize(result),
      exempt('validate_plan', result as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidatePlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    VALIDATE_PLAN_TOOL_NAME,
    {
      title: 'Validate a plan before anybody reviews it',
      description:
        'Check whether a PLAN you are authoring is finishable once it materializes — the ' +
        'pre-commit check to run BEFORE `add_plan_items` with `final: true`, which is the only ' +
        'moment it is cheap. It answers over the project’s live tree ⊕ this plan’s proposals: ' +
        'VALID ⟺ every not-done item in the projected forest has each blocked_by dependency ' +
        'either inside the projection (it materializes with the plan) or already done. Returns ' +
        '`{ planId, valid, blockers: [...] }`, each blocker naming the gated item and the work ' +
        'gating it; an item named `planItem:<id>` is a PROPOSAL in this plan, not a work item. ' +
        '`condition` defaults to `loose` (a done dependency outside the plan counts as ' +
        'satisfied); `tight` requires every dependency to be IN the projection. This is the ' +
        'WHOLE-plan verdict and takes no target — use `validate_work_item` with a `planId` for ' +
        'one subtree. Do NOT approximate it by looping that call per root: a blocked_by edge ' +
        'between two sibling roots is valid here and a false positive per-root, because both ' +
        'roots materialize together. Read-only: it creates nothing, mutates nothing and ' +
        'persists nothing, and approving the plan in Motir remains the only path from a ' +
        'proposal to a work item.',
      inputSchema,
    },
    async (args, extra) => runValidatePlan(args, resolveContext(extra)),
  );
}
