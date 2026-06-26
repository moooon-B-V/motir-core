import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { SprintValidityDto, ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { conditionField, projectKeyField, sprintIdField } from './sprintRef';

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
// A thin READ adapter over `sprintsService.validateSprint` — no business logic
// here; the closure walk + the validity rule live in the service. READ scope
// (`lib/mcp/scopes.ts`), like `list_sprints`.

export const VALIDATE_SPRINT_TOOL_NAME = 'validate_sprint';

const inputSchema = {
  projectKey: projectKeyField,
  sprintId: sprintIdField
    .optional()
    .describe('The sprint to validate; omit to validate the project’s ACTIVE sprint.'),
  condition: conditionField,
};

interface ValidateSprintArgs {
  projectKey: string;
  sprintId?: string;
  condition?: ValidityCondition;
}

/** Human-readable summary for the dual-content text block. */
function summarize(result: SprintValidityDto): string {
  if (result.valid) {
    return `Sprint ${result.sprintId} is VALID — every in-sprint item can be finished within it.`;
  }
  return [
    `Sprint ${result.sprintId} is INVALID — ${result.blockers.length} in-sprint item(s) are gated ` +
      'by out-of-sprint, not-done work:',
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
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    // `conditionField` defaults to `loose`, so `args.condition` is already set;
    // when truly absent the service param's own default ('loose') applies. No
    // `??` here — it would add a never-taken branch (the schema fills the value).
    const result = await sprintsService.validateSprint(
      project.id,
      args.sprintId ?? null,
      ctx,
      args.condition,
    );
    return toolOk(summarize(result), result as unknown as Record<string, unknown>);
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
        'not-done work gating it. Read-only.',
      inputSchema,
    },
    async (args, extra) => runValidateSprint(args, resolveContext(extra)),
  );
}
