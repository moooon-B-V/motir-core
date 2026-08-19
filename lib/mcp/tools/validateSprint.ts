import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { planValidityService } from '@/lib/services/planValidityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { SprintValidityDto, ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { conditionField, projectKeyField, sprintIdField } from './sprintRef';
import { planIdField } from './planRef';

// `validate_sprint` (Story 7.8 · Subtask 7.8.15) — is a sprint FINISHABLE? The
// productized form of the *re-validate-the-active-sprint* rule (`motir-meta`
// `plan-rules.md` #94): a planning agent calls this after any plan/re-plan that
// touches sprint membership or a sprint item's `blocked_by` edges. A sprint is
// VALID ⟺ every in-sprint, not-done item has BOTH its ENTIRE transitive
// `blocked_by` closure AND all of its children `done` OR also in the sprint —
// the parent-ready cascade applied to the sprint: a parent with an out-of-sprint
// not-done child can never be finished within it. With NO `sprintId`, the
// project's ACTIVE sprint is validated.
//
// `condition` (Subtask 7.8.22) tunes the out-of-sprint `done` case: `loose`
// (default) accepts a done blocker/child anywhere; `tight` requires it to be IN
// the sprint, else it is reported as a blocker.
//
// `planId` (MOTIR-3095) switches the same question onto the PROJECTED tree —
// *will the active sprint still be finishable once this plan materializes?* —
// mirroring `POST /api/internal/ai/validate-plan-sprint` 1:1, including what
// that route does NOT take. It has no `projectKey` and no `sprintId` because
// the plan names its own project and the answer is always about that project's
// ACTIVE sprint; an `add` lands in the backlog and `PlanItemPatch` carries no
// sprint field, so a plan cannot move anything into a sprint.
//
// So on the projected path `projectKey` is not required (the plan supplies it)
// and `sprintId` is REFUSED rather than ignored. Accepting an argument that
// cannot be honoured is the fiction `docs/decisions/agent-authored-plans.md` §3
// forbids in the permission map, applied one layer out.
//
// A thin READ adapter over `sprintsService.validateSprint` /
// `planValidityService.validateProjectedSprint` — no business logic here; the
// closure walk + the validity rule live in the service, and the projected mode
// runs the SAME rule over a different node set. READ scope
// (`lib/mcp/scopes.ts`), like `list_sprints`.

export const VALIDATE_SPRINT_TOOL_NAME = 'validate_sprint';

const inputSchema = {
  projectKey: projectKeyField
    .optional()
    .describe(
      'The project key the sprint belongs to — the prefix chosen for that project at ' +
        'creation (e.g. "ACME"), not a reserved value. REQUIRED unless `planId` is given, ' +
        'which names its own project.',
    ),
  sprintId: sprintIdField
    .optional()
    .describe(
      'The sprint to validate; omit to validate the project’s ACTIVE sprint. Not accepted ' +
        'with `planId` — a projected verdict is always about the ACTIVE sprint.',
    ),
  condition: conditionField,
  planId: planIdField,
};

interface ValidateSprintArgs {
  projectKey?: string;
  sprintId?: string;
  condition?: ValidityCondition;
  planId?: string;
}

/** Human-readable summary for the dual-content text block.
 *
 * `planId` is present ⟺ the verdict was computed over the PROJECTION. The DTO
 * is the same shape either way, so this block is the only place a reader
 * watching the session can see which tree it was computed over. */
function summarize(result: SprintValidityDto, planId?: string): string {
  const over = planId
    ? ` once plan ${planId} materializes (nothing was created — approving the plan in Motir is ` +
      'still the only path from a proposal to a work item)'
    : '';
  if (result.valid) {
    return `Sprint ${result.sprintId} is VALID — every in-sprint item can be finished within it${over}.`;
  }
  return [
    `Sprint ${result.sprintId} is INVALID${over} — ${result.blockers.length} in-sprint item(s) ` +
      'are gated by out-of-sprint, not-done work:',
    ...result.blockers.map(
      (b) =>
        `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
        `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
    ),
    'Pull these blockers into the sprint, or move the gated items back to the backlog and re-plan.',
  ].join('\n');
}

export async function runValidateSprint(
  args: ValidateSprintArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    // `conditionField` defaults to `loose`, so `args.condition` is already set;
    // when truly absent the service param's own default ('loose') applies. No
    // `??` here — it would add a never-taken branch (the schema fills the value).
    if (args.planId !== undefined) {
      // REFUSED, not ignored: the projected verdict is always about the ACTIVE
      // sprint (`validateProjectedSprint` resolves it itself), so honouring a
      // named sprint is not something this path can do.
      if (args.sprintId !== undefined) {
        return toolError(
          'VALIDATE_SPRINT_INVALID',
          'sprintId is not accepted with planId — a projected verdict is always about the ' +
            'project’s ACTIVE sprint. Drop sprintId, or drop planId to validate a named sprint ' +
            'as it stands today.',
        );
      }
      // No project lookup: `buildProjection` resolves the project FROM the plan
      // and asserts browse on it, exactly as the internal route does.
      const projected = await planValidityService.validateProjectedSprint(
        args.planId,
        ctx,
        args.condition,
      );
      return toolOk(
        summarize(projected, args.planId),
        exempt('validate_sprint', projected as unknown as Record<string, unknown>),
      );
    }
    if (args.projectKey === undefined) {
      return toolError(
        'VALIDATE_SPRINT_INVALID',
        'projectKey is required unless planId is given (a plan names its own project).',
      );
    }
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const result = await sprintsService.validateSprint(
      project.id,
      args.sprintId ?? null,
      ctx,
      args.condition,
    );
    return toolOk(
      summarize(result),
      exempt('validate_sprint', result as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidateSprint(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    VALIDATE_SPRINT_TOOL_NAME,
    {
      title: 'Validate sprint finishability',
      description:
        'Check whether a sprint is FINISHABLE: every in-sprint item has both its entire transitive ' +
        'blocked_by closure AND all of its children either done or also in the sprint (the ' +
        'parent-ready cascade applied to the sprint — a parent with an out-of-sprint, not-done ' +
        'child can never be finished within it). Omit sprintId to validate the project’s ACTIVE ' +
        'sprint. `condition` defaults to `loose` (a done item outside the sprint counts as ' +
        'satisfied); pass `tight` to require every gating item to be IN the sprint (a done item ' +
        'outside it is then reported as a blocker). Returns `{ valid: true }` when finishable, else ' +
        '`{ valid: false, blockers: [...] }` naming each in-sprint item and the out-of-sprint, ' +
        'not-done work gating it. Pass `planId` to ask the same question over a plan you are ' +
        'authoring — *will the active sprint still be finishable once this plan materializes?* ' +
        'On that path the plan names its own project (so projectKey is not required) and the ' +
        'verdict is always about the ACTIVE sprint, so sprintId is refused rather than ignored. ' +
        'Read-only, projected or not: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runValidateSprint(args, resolveContext(extra)),
  );
}
