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

/**
 * Human-readable summary for the dual-content text block.
 *
 * ⚠️ IT RENDERS THE TWO FAILURE FAMILIES SEPARATELY, and that is the point rather
 * than presentation (MOTIR-3575). They need OPPOSITE repairs — an unfinishable
 * plan has a dependency reaching outside it, an unapprovable one is malformed —
 * and a caller that cannot tell them apart re-authors the wrong half. The VALID
 * arm no longer claims more than was checked: it used to promise finishability
 * only, in a sentence a reader takes as *this plan is sound*, which is what made
 * a plan the approve button then refused safe to close.
 */
function summarize(result: PlanValidityDto): string {
  if (result.valid) {
    return (
      `Plan ${result.planId} is VALID — it would be ACCEPTED by approve, and every item in ` +
      'the projected forest can be finished once it materializes. No work item was created: ' +
      'approving the plan in Motir is still the only path from a proposal to a work item.'
    );
  }

  const lines: string[] = [`Plan ${result.planId} is INVALID.`];

  if (result.rejections.length > 0) {
    lines.push(
      '',
      'APPROVE WOULD REFUSE IT — the plan is malformed, so no amount of re-sequencing helps:',
      ...result.rejections.map(
        (r) => `  ${r.item}: ${r.code}${r.reason ? ` / ${r.reason}` : ''} — ${r.message}`,
      ),
      'Fix this BEFORE `final: true`: once the plan is `planned` its proposals are frozen, and ' +
        'the only repair left is to author a new plan and decline this one. Only ONE rejection ' +
        'is reported at a time — the check stops at the first — so re-run this after fixing it.',
    );
  }

  if (result.blockers.length > 0) {
    lines.push(
      '',
      `${result.blockers.length} item(s) in the projected forest are gated by work that is ` +
        'neither in the plan nor done:',
      ...result.blockers.map(
        (b) =>
          `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
          `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
      ),
      'Fix each edge before `final: true` — that is the only moment this check is cheap. An ' +
        'item named `planItem:<id>` is a proposal in THIS plan, not a work item.',
    );
  }

  return lines.join('\n');
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
        'Check whether a PLAN you are authoring is SOUND — the pre-commit check to run BEFORE ' +
        '`add_plan_items` with `final: true`, which is the only moment it is cheap, because a ' +
        '`planned` plan’s proposals are frozen and the only repair left is a new plan. It ' +
        'answers TWO questions over the project’s live tree ⊕ this plan’s proposals, and ' +
        'VALID means BOTH pass. (1) APPROVABLE — would the approve button take it? A dangling ' +
        'ref, a duplicated blocker, a ref cycle, an illegal kind-parent placement, or a ' +
        '`modify`/`remove` of already-completed work each make it refuse; these arrive in ' +
        '`rejections`, at most one at a time because the check stops at the first, so re-run ' +
        'after fixing one. (2) FINISHABLE — every not-done item in the projected forest has ' +
        'each blocked_by dependency either inside the projection (it materializes with the ' +
        'plan) or already done; these arrive in `blockers`, each naming the gated item and the ' +
        'work gating it. The two need OPPOSITE repairs: a rejection means the plan is ' +
        'malformed, a blocker means it reaches outside itself. Returns ' +
        '`{ planId, valid, rejections: [...], blockers: [...] }`; an item named ' +
        '`planItem:<id>` is a PROPOSAL in this plan, not a work item. ' +
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
