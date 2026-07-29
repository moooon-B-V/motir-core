import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { aiPlanEditsService, type PlanOutcomeRef } from '@/lib/services/aiPlanEditsService';
import type { PlanEditSubmitResult } from '@/lib/services/aiPlanEditsService';
import type { PlanOutcomeDto } from '@/lib/dto/plans';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `expand_item` + `get_plan_status` (Story 7.9 · MOTIR-1825) — the MCP surface
// for AI plan EXPANSION, and the outcome read that makes it usable headlessly.
//
// Why they exist: expansion shipped with an HTTP route (`POST /api/ai/expand`)
// and a diff-review UI, both cookie-authed. The CLI is an MCP client only — no
// parallel REST path, one auth path (the Story 7.9 header) — so without a tool
// there is no mechanism at all for an unattended run to grow its own backlog.
//
// Two contracts these tools hold, both load-bearing:
//
//  1. SUBMIT AND RETURN. `expand_item` hands back `{ jobId, planId }` the moment
//     motir-ai accepts the job. It never streams, never waits, never polls — the
//     browser surfaces stream because a human is watching; a CLI has nobody to
//     show a comet to, and an agent blocked on an LLM run is an agent not
//     working. `get_plan_status` is the come-back-later half.
//  2. A PROPOSAL IS NOT A TREE WRITE. An expansion emits a `Plan` of `PlanItem`
//     PROPOSALS. `plansService.approvePlan` is the ONLY path from a proposal to
//     a work item, and an `add`'s `workItemId` stays NULL until then. So firing
//     this tool does NOT grow the tree, and polling it to `planned` does not
//     either. Both tool descriptions say so in as many words, because the whole
//     failure mode here is a client — human or agent — inferring otherwise and
//     reporting work it never created.
//
// No business logic lives here: `aiPlanEditsService` already owns the submit
// (`submitExpand`, reused verbatim) and the outcome read, exactly as the cookie
// route reuses it. The tools are transports that swap the cookie session for the
// PAT-resolved context, so every credit / tenancy / access check is unchanged.

export const EXPAND_ITEM_TOOL_NAME = 'expand_item';
export const GET_PLAN_STATUS_TOOL_NAME = 'get_plan_status';

const expandInputSchema = {
  key: workItemKeyField,
};

const planStatusInputSchema = {
  planId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('The plan id an `expand_item` submit returned. Pass this OR `jobId`.'),
  jobId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('The job id an `expand_item` submit returned. Pass this OR `planId`.'),
};

/**
 * Widen the MCP tool's `ServiceContext` to the `ProjectContext` the plan-edit
 * service takes, by resolving the project the item key names. `getByKey` applies
 * the same browse gate the cookie route's `getActiveProject` does, and keeps the
 * 404-not-403 contract for a project outside the caller's workspace — so an
 * unauthorized expansion fails identically to every other tool's.
 */
async function projectContextFor(identifier: string, ctx: ServiceContext): Promise<ProjectContext> {
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id, project };
}

/** Compact summary for the human watching; the ids ride in `structuredContent`. */
function summarizeSubmit(identifier: string, result: PlanEditSubmitResult): string {
  return [
    `Expansion submitted for ${identifier}.`,
    `Job: ${result.jobId} · Plan: ${result.planId}`,
    '',
    'The job runs in the background — nothing is waiting on it. It produces a plan of ' +
      'PROPOSALS; no work item exists until the plan is approved. Read ' +
      `\`${GET_PLAN_STATUS_TOOL_NAME}\` with this plan id to see what became of it.`,
  ].join('\n');
}

function summarizeOutcome(outcome: PlanOutcomeDto): string {
  const lines = [
    `Plan ${outcome.planId} — ${outcome.status}, ${outcome.itemCount} proposal(s).`,
    `Origin: ${outcome.origin}${outcome.jobId ? ` · job ${outcome.jobId}` : ''}`,
  ];
  if (outcome.job) {
    if (!outcome.job.reachable) {
      lines.push(
        `The job's state could not be read (${outcome.job.failure?.code}) — the plan is still ` +
          'generating as far as Motir knows.',
      );
    } else if (outcome.job.failure) {
      lines.push(
        `The job FAILED (${outcome.job.failure.code}: ${outcome.job.failure.message}). The plan ` +
          'will stay generating — nothing more will arrive on it.',
      );
    } else {
      lines.push(`The job is ${outcome.job.status} — proposals are still arriving.`);
    }
  }
  lines.push(
    '',
    outcome.status === 'approved'
      ? 'This plan was approved — its proposals were materialized into work items.'
      : 'These are PROPOSALS. No work item is created until the plan is approved.',
  );
  return lines.join('\n');
}

/** The adapter: resolve the project from the key prefix, submit, return. */
export async function runExpandItem(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  const projectCtx = await projectContextFor(identifier, ctx);
  const result = await aiPlanEditsService.submitExpand(identifier, projectCtx);
  return toolOk(summarizeSubmit(identifier, result), { ...result });
}

/** The adapter: address the plan by whichever id the caller kept, then read it. */
export async function runGetPlanStatus(
  args: { planId?: string; jobId?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  // Exactly one — zod cannot express the xor across two optional fields, so the
  // check lives here and returns the same self-correctable shape a service's
  // typed error would.
  if (Boolean(args.planId) === Boolean(args.jobId)) {
    return toolError(
      'BAD_REQUEST',
      'Pass exactly one of `planId` or `jobId` — both come from the same expand_item result.',
    );
  }
  const ref: PlanOutcomeRef = args.planId ? { planId: args.planId } : { jobId: args.jobId! };
  const outcome = await aiPlanEditsService.getOutcome(ref, ctx);
  return toolOk(summarizeOutcome(outcome), outcome as unknown as Record<string, unknown>);
}

export function registerExpandItem(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    EXPAND_ITEM_TOOL_NAME,
    {
      title: 'Expand work item',
      description:
        'Submit an AI expansion of one CONTAINER work item (epic / story / task / bug, by ' +
        'identifier e.g. "PROD-7"): the planner drafts the children it should have. Returns ' +
        '`{ jobId, planId }` IMMEDIATELY — it does not wait for the planner, so poll ' +
        `\`${GET_PLAN_STATUS_TOOL_NAME}\` for the outcome. ` +
        'IMPORTANT: this does NOT create work items. The job produces a PLAN of proposals; ' +
        'approving that plan is the only thing that turns a proposal into a work item, and ' +
        'approval happens in Motir, not here. Do not report expanded children as created. ' +
        'A leaf (subtask) cannot be expanded. Runs on the AI credits of the token owner.',
      inputSchema: expandInputSchema,
    },
    async (args, extra) => {
      try {
        return await runExpandItem(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    GET_PLAN_STATUS_TOOL_NAME,
    {
      title: 'Plan status',
      description:
        'Read what became of a submitted planning job — pass EITHER the `planId` or the ' +
        '`jobId` an `expand_item` call returned. Reports the plan status ' +
        '(generating / planned / approved / declined), how many proposals it bundles, and — ' +
        'while it is still generating — whether the job is running or FAILED (a failed job ' +
        'leaves its plan generating forever, so the plan status alone cannot tell you). ' +
        'A pure read. The proposal count is NOT a count of created work items: nothing ' +
        'reaches the tree until the plan is approved in Motir.',
      inputSchema: planStatusInputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetPlanStatus(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
