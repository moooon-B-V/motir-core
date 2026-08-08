import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import type { PlanChangeSessionDto, PlanChangeSubmitResultDto } from '@/lib/dto/planChange';
import { TooManyPlanChangeTargetsError } from '@/lib/planChange/errors';
import { buildScope, MAX_SCOPE_TARGETS, PROJECT_SCOPE } from '@/lib/planChange/scope';
import type { PlanChangeScope } from '@/lib/planChange/scope';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import {
  planSessionPayload,
  planSubmitPayload,
  presentMcpPlanSession,
  presentMcpPlanSubmit,
} from '../payloads/workLoop';
import { projectKeyField } from './readyFilters';
import { normalizeIdentifier } from './workItemRef';

// `open_plan_session` + `append_plan_turn` + `submit_plan_session`
// (Story 7.9 · MOTIR-1832) — the MCP surface for CHANGING A PLAN BY TALKING,
// which is what `motir plan` (MOTIR-887) needs a mechanism for.
//
// Why they exist, and why THREE of them: Motir's planning front door is not a
// one-shot prompt, it is a persisted, resumable CONVERSATION (Story 7.30 ·
// MOTIR-1728, widened to anchored threads by 7.12.3 · MOTIR-909). A thread
// ACCUMULATES turns and is SUBMITTED as one accumulated intent — accumulation
// and submission are separate acts, and collapsing them into a single
// `plan(prompt)` tool would throw away the refinement that makes the seam worth
// having. That substrate ships today behind `POST /api/ai/plan-change/session`,
// `…/turns` and `…/submit`, all cookie-authed; the CLI is an MCP client only
// (the Story 7.9 header), so without these tools a terminal client has no
// mechanism to reach it at all.
//
// Three contracts they hold, all load-bearing:
//
//  1. ONE THREAD PER SCOPE, ADDRESSED BY SCOPE. A thread's identity is
//     `(project, anchor set)` — `@@unique([projectId, scopeKey])`. So these
//     tools take `{ projectKey, targetKeys? }` and NOT a client-held session id:
//     re-opening the same anchor set RESUMES the same row the web panel is
//     looking at, and a CLI cannot desynchronise from it or fork a second
//     conversation about the same items.
//  2. APPENDING IS NOT SUBMITTING. `append_plan_turn` costs nothing and starts
//     no job; `submit_plan_session` is the act that spends the owner's AI
//     credits. Both descriptions say so, because an agent that assumes an append
//     submitted will sit polling a job that was never created.
//  3. A SUBMIT PROPOSES; IT DOES NOT WRITE THE TREE. The job produces a `Plan`
//     of `PlanItem` PROPOSALS, and `plansService.approvePlan` — a decision made
//     in Motir, not on this surface — is the only path from a proposal to a work
//     item. Same gate `expand_item` carries, same wording, for the same reason:
//     the failure mode is a client reporting work it never created.
//
// No business logic lives here. `planChangeSessionsService` owns get-or-create /
// append / submit (including the row-locked `seq` allocation, the accumulated
// intent, and the contextual-vs-augment routing, which is decided by the
// THREAD's own scope — there is no second submit surface and no second job
// kind). These tools swap the cookie session for the PAT-resolved context, so
// every credit / tenancy / access check is unchanged.
//
// ⚠️ What this surface deliberately does NOT do: GENERATE a plan for an EMPTY
// project. `submit` reaches `augment` / contextual, never `generate_tree` —
// generation is driven by the onboarding discovery interview, a different
// conversation substrate. Whether `motir plan` should drive that too is pinned
// on MOTIR-887 / MOTIR-1833's ADR; no third path is invented here.

export const OPEN_PLAN_SESSION_TOOL_NAME = 'open_plan_session';
export const APPEND_PLAN_TURN_TOOL_NAME = 'append_plan_turn';
export const SUBMIT_PLAN_SESSION_TOOL_NAME = 'submit_plan_session';

const targetKeysField = z
  .array(z.string().trim().min(1))
  .max(MAX_SCOPE_TARGETS)
  .optional()
  .describe(
    'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) ' +
      'to ANCHOR the conversation at. Omit for the project-wide planning thread. The ' +
      "anchor SET is the thread's identity — order and duplicates do not matter, and " +
      'the same set always resumes the same conversation.',
  );

const scopeInputSchema = {
  projectKey: projectKeyField,
  targetKeys: targetKeysField,
};

const appendInputSchema = {
  projectKey: projectKeyField,
  targetKeys: targetKeysField,
  body: z
    .string()
    .trim()
    .min(1)
    .describe('What to say in this turn — what you want changed about the plan.'),
};

interface ScopeArgs {
  projectKey: string;
  targetKeys?: string[];
}

interface AppendArgs extends ScopeArgs {
  body: string;
}

/** A project + the thread's scope, both resolved from the caller's arguments. */
interface ResolvedTarget {
  pctx: ProjectContext;
  scope: PlanChangeScope;
}

/**
 * Resolve `{ projectKey, targetKeys }` into the `ProjectContext` the
 * conversation service takes and the CANONICAL scope of the thread it names.
 *
 * Two gates run here, and neither is optional:
 *
 *  - `projectsService.getByKey` applies the same browse gate the cookie routes'
 *    `getActiveProject` does, keeping the 404-not-403 contract for a project
 *    outside the caller's workspace (this is `expand_item`'s `projectContextFor`,
 *    addressed by project key rather than by an item key's prefix).
 *  - EVERY anchor is resolved through `workItemsService`, the 6.4 permission
 *    authority: a cross-tenant or unbrowsable item 404s here instead of
 *    silently becoming a scope key. This is the invariant
 *    `planChangeSessionsService` documents — a scope is built from an
 *    ALREADY-RESOLVED anchor set, never from raw client input — and it is the
 *    same resolution `contextualPlanningService` performs for the web panel.
 *    (That service's own resolver cannot be reused verbatim: it is anchored on a
 *    work item's DATABASE id, which a key-addressed MCP surface never holds. The
 *    bound, the typed error and the canonicalization are imported rather than
 *    restated, so the two cannot drift on what an anchor set means.)
 */
async function resolveTarget(args: ScopeArgs, ctx: ServiceContext): Promise<ResolvedTarget> {
  const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
  const pctx: ProjectContext = {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId: project.id,
    project,
  };

  // Normalized the way every key-addressed tool normalizes (`normalizeIdentifier`):
  // identifiers are case-insensitive across the API, and the repository lookup
  // behind `getWorkItemByIdentifier` is an EXACT unique match — so "prod-7" must
  // become "ACME-7" here or it reads as a not-found item.
  const requested = (args.targetKeys ?? []).map(normalizeIdentifier).filter(Boolean);
  if (requested.length === 0) return { pctx, scope: PROJECT_SCOPE };
  // Bound BEFORE the round-trips: the cost of a huge set is the resolution
  // fan-out itself, so rejecting after resolving them would be too late.
  if (requested.length > MAX_SCOPE_TARGETS) {
    throw new TooManyPlanChangeTargetsError(requested.length, MAX_SCOPE_TARGETS);
  }

  const identifiers: string[] = [];
  for (const key of requested) {
    const item = await workItemsService.getWorkItemByIdentifier(project.id, key, ctx);
    identifiers.push(item.identifier);
  }
  return { pctx, scope: buildScope(identifiers) };
}

/** How a thread is named in the summary — the project, or its anchor set. */
function scopeLabel(session: PlanChangeSessionDto): string {
  return session.targetKeys.length > 0
    ? `anchored at ${session.targetKeys.join(', ')}`
    : 'project-wide';
}

/** One turn as a compact line; long bodies are excerpted (the `add_comment`
 *  convention) — the full thread rides in `structuredContent`. */
function turnLine(turn: PlanChangeSessionDto['turns'][number]): string {
  const body = turn.body.length > 280 ? turn.body.slice(0, 280) + '…' : turn.body;
  const marker = turn.role === 'system' ? `submitted → job ${turn.jobId ?? '?'}` : 'you';
  return `  ${turn.seq}. [${marker}] ${body}`;
}

/** The thread as a human-readable transcript, headline first. */
function summarizeSession(session: PlanChangeSessionDto, headline: string): string {
  const lines = [
    `${headline} (${scopeLabel(session)}) — ${session.turnCount} turn(s).`,
    session.lastSubmittedAt
      ? `Last submitted ${session.lastSubmittedAt}${session.lastJobId ? ` as job ${session.lastJobId}` : ''}.`
      : 'Never submitted — nothing has been sent to the planner yet.',
  ];
  if (session.turns.length > 0) {
    lines.push('', ...session.turns.map(turnLine));
  }
  lines.push(
    '',
    'Turns ACCUMULATE — adding one does NOT submit anything. Call ' +
      `\`${SUBMIT_PLAN_SESSION_TOOL_NAME}\` when the intent is complete; the planner ` +
      'then receives every turn on this thread, in order, as one change.',
  );
  return lines.join('\n');
}

function summarizeSubmit(result: PlanChangeSubmitResultDto): string {
  return [
    `Submitted this conversation's accumulated intent (${scopeLabel(result.session)}).`,
    `Job: ${result.jobId} · Plan: ${result.planId}`,
    '',
    'The job runs in the background — nothing is waiting on it. It produces a plan of ' +
      'PROPOSALS; no work item exists until the plan is approved in Motir. Read ' +
      '`get_plan_status` with this plan id to see what became of it. The thread is ' +
      'intact and can be refined further with another turn.',
  ].join('\n');
}

/** The adapter: resolve the scope, then get-or-resume that thread. */
export async function runOpenPlanSession(
  args: ScopeArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const { pctx, scope } = await resolveTarget(args, ctx);
  const session = await planChangeSessionsService.getOrCreateForScope(pctx, scope);
  const headline =
    session.turnCount > 0 ? 'Resumed planning conversation' : 'Opened planning conversation';
  return toolOk(
    summarizeSession(session, headline),
    derived(planSessionPayload, presentMcpPlanSession(session)),
  );
}

/**
 * The adapter: get-or-resume the thread, then append the turn.
 *
 * Get-or-create FIRST is the shipped composition, not an invention: it is
 * exactly what `contextualPlanningService.planFromWorkItem` does for the web
 * panel, and it is idempotent per scope. It matters more here than in the
 * browser — the rail opens its thread on mount, whereas a terminal client has
 * no mount, so requiring a separate `open` call before a first turn would be a
 * round-trip that buys nothing and a 404 an agent has to learn its way out of.
 */
export async function runAppendPlanTurn(
  args: AppendArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const { pctx, scope } = await resolveTarget(args, ctx);
  await planChangeSessionsService.getOrCreateForScope(pctx, scope);
  const session = await planChangeSessionsService.appendTurn(args.body, pctx, scope.scopeKey);
  return toolOk(
    summarizeSession(session, 'Turn added — NOT submitted'),
    derived(planSessionPayload, presentMcpPlanSession(session)),
  );
}

/** The adapter: resolve the scope, submit the thread, return the ids. */
export async function runSubmitPlanSession(
  args: ScopeArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const { pctx, scope } = await resolveTarget(args, ctx);
  const result = await planChangeSessionsService.submit(pctx, scope.scopeKey);
  return toolOk(summarizeSubmit(result), derived(planSubmitPayload, presentMcpPlanSubmit(result)));
}

export function registerPlanSession(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    OPEN_PLAN_SESSION_TOOL_NAME,
    {
      title: 'Open plan conversation',
      description:
        'Open — or RESUME — the planning conversation for a project, and read its thread. ' +
        'Changing a plan in Motir is a multi-turn CONVERSATION: you add turns with ' +
        `\`${APPEND_PLAN_TURN_TOOL_NAME}\`, then send the accumulated intent with ` +
        `\`${SUBMIT_PLAN_SESSION_TOOL_NAME}\`. There is ONE thread per project per anchor ` +
        'set, so calling this again returns the SAME conversation (with every turn already ' +
        'on it) rather than starting a second one — including the one the Motir web app ' +
        'shows. Pass `targetKeys` to anchor the conversation at specific work items ' +
        '("re-plan these two"); omit it for the project-wide thread. ' +
        'Opening submits nothing and costs nothing.',
      inputSchema: scopeInputSchema,
    },
    async (args, extra) => {
      try {
        return await runOpenPlanSession(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    APPEND_PLAN_TURN_TOOL_NAME,
    {
      title: 'Add a planning turn',
      description:
        'Add one turn to a project’s planning conversation — what you want changed about ' +
        'the plan. IMPORTANT: appending does NOT submit. Turns accumulate on the thread ' +
        'until you call ' +
        `\`${SUBMIT_PLAN_SESSION_TOOL_NAME}\`, which is what sends them to the planner; ` +
        'that separation is the point — a later turn REFINES the earlier ones rather than ' +
        'replacing them, so "add auth to the billing epic" then "keep them under 3 points" ' +
        'go out as ONE coherent change. Nothing is generated, no credits are spent, and no ' +
        'work item changes until you submit and the resulting plan is approved. Addresses ' +
        'the thread by scope (`projectKey` + optional `targetKeys`), so it always extends ' +
        'the same conversation the Motir web app is showing.',
      inputSchema: appendInputSchema,
    },
    async (args, extra) => {
      try {
        return await runAppendPlanTurn(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    SUBMIT_PLAN_SESSION_TOOL_NAME,
    {
      title: 'Submit plan conversation',
      description:
        'Send a planning conversation’s ACCUMULATED intent — every turn on the thread, in ' +
        'order — to the planner as ONE change. Returns `{ jobId, planId }` IMMEDIATELY; it ' +
        'does not wait for the planner, so poll `get_plan_status` for the outcome. ' +
        'IMPORTANT: this does NOT create work items. The job produces a PLAN of proposals; ' +
        'approving that plan is the only thing that turns a proposal into a work item, and ' +
        'approval happens in Motir, not here. Do not report proposed work as created. ' +
        'A thread with no turns yet is refused (add one first); a failed submit leaves the ' +
        'thread intact, so your turns are never lost. Runs on the AI credits of the token ' +
        'owner.',
      inputSchema: scopeInputSchema,
    },
    async (args, extra) => {
      try {
        return await runSubmitPlanSession(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
