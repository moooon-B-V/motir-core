import { z } from 'zod/v4';
import {
  dispatchPromptSchema,
  integrationResultSchema,
  planOutcomeSchema,
  planSchema,
  planSessionSchema,
  presentDispatchPrompt,
  presentPlanJobHandle,
  presentPlanOutcome,
  presentPlanSession,
  presentSessionCloseOut,
  planJobHandleSchema,
  sessionCloseOutSchema,
} from '@/lib/api/v1/workLoop/schema';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import type { PlanOutcomeDto, PlanWithItemsDto } from '@/lib/dto/plans';
import { definePayload } from './define';
import { mcpWorkItemSchema, type McpWorkItem } from './workItems';

// The WORK-LOOP payload shapes (Story 11.6 · Subtask 11.6.5 — MOTIR-2231).
//
// The last family, and the one that only became possible when 11.7 (MOTIR-2208)
// gave these resources a v1 schema to derive from. Six of the eight tools that
// hand-built `structuredContent` live here, so proportionally this is where the
// hand-shaping was densest — and it is the newest half of the surface, which is
// precisely where two independently-written descriptions drift first.
//
// ── The RENAME hazard, and why these are widenings ──────────────────────────
// v1's plan presenters deliberately RENAME as they map: `itemCount` becomes
// `proposalCount` (because "item" means WORK ITEM everywhere else on that API,
// and none exist until a plan is approved), and `items` becomes `proposals`.
// Those renames are right for v1 and they are NOT free here: ADR Amendment 7 Q6
// makes a renamed key a violation, because a client reading the old name would
// silently get `undefined`. So the plan payloads carry BOTH — the v1 name from
// v1's own presenter, and the original beside it. Additive, as the rule requires.

/**
 * The DISPATCH prompt. `DispatchPromptDto` and `dispatchPromptSchema` have the
 * same eight fields, so this derives with no widening and carries a real probe.
 *
 * The advisories are re-shaped per variant by v1's presenter rather than passed
 * through — which is the point of the seam: a field added to
 * `WorkItemProseAdvisoryDto` for an internal consumer cannot reach either
 * surface by accident.
 */
export const dispatchPromptPayload = definePayload({
  schema: dispatchPromptSchema as unknown as z.ZodType<z.infer<typeof dispatchPromptSchema>>,
  probes: [{ resource: 'DispatchPrompt', select: (p) => [p] }],
});

/** Map a dispatch payload — v1's own presenter, unchanged. */
export function presentMcpDispatchPrompt(
  dto: DispatchPromptDto,
): z.infer<typeof dispatchPromptSchema> {
  return presentDispatchPrompt(dto);
}

/**
 * The SESSION close-out. `{ sessionBranch, results: [{ key, outcome, reason? }] }`
 * on both surfaces — they already agreed, so this derives exactly.
 */
export const sessionCloseOutPayload = definePayload({
  schema: sessionCloseOutSchema as unknown as z.ZodType<z.infer<typeof sessionCloseOutSchema>>,
  probes: [{ resource: 'SessionCloseOut', select: (p) => [p] }],
});

/** Map a close-out result — v1's own presenter, unchanged. */
export function presentMcpSessionCloseOut(result: {
  sessionBranch: string;
  results: { key: string; outcome: 'completed' | 'already_done' | 'failed'; reason?: string }[];
}): z.infer<typeof sessionCloseOutSchema> {
  return presentSessionCloseOut(result);
}

/**
 * The JOB HANDLE both submitting tools return.
 *
 * ⚠️ This shape signals "ACCEPTED, not finished" by what it cannot carry — no
 * `items`, no `proposals`, no `count`, no `status`. A client cannot mistake it
 * for a result, and that property is worth more than the two fields it has.
 * `expand_item` and `submit_plan_session` both return it.
 */
export const planJobHandlePayload = definePayload({
  schema: planJobHandleSchema as unknown as z.ZodType<z.infer<typeof planJobHandleSchema>>,
  probes: [{ resource: 'PlanJobHandle', select: (p) => [p] }],
});

/** Map a job handle — v1's own presenter, unchanged. */
export function presentMcpPlanJobHandle(result: {
  jobId: string;
  planId: string;
}): z.infer<typeof planJobHandleSchema> {
  return presentPlanJobHandle(result);
}

/**
 * `submit_plan_session`'s result — the job handle WIDENED with the thread it was
 * submitted from.
 *
 * MCP has always returned the session alongside, and a resumed client re-attaches
 * from its marker turn, so dropping it to match v1's bare handle would be a
 * removal — the one thing ADR Amendment 7 Q6 does not permit. v1's endpoint
 * answers with the handle alone, which is right for a caller that will poll;
 * the overlap is still one schema, and the probe asserts it.
 */
export const mcpPlanSubmitSchema = planJobHandleSchema.extend({
  session: planSessionSchema,
});
export type McpPlanSubmit = z.infer<typeof mcpPlanSubmitSchema>;

/** Map a submit result — both halves through v1's own presenters. */
export function presentMcpPlanSubmit(result: {
  jobId: string;
  planId: string;
  session: Parameters<typeof presentPlanSession>[0];
}): McpPlanSubmit {
  return {
    ...presentPlanJobHandle(result),
    session: presentPlanSession(result.session),
  };
}

/** The `submit_plan_session` payload. */
export const planSubmitPayload = definePayload({
  schema: mcpPlanSubmitSchema as unknown as z.ZodType<McpPlanSubmit>,
  probes: [
    { resource: 'PlanJobHandle', select: (p) => [p] },
    { resource: 'PlanSession', select: (p) => [p.session] },
  ],
});

/**
 * A plan's STATUS — v1's `PlanOutcome` widened with the two names the MCP
 * payload already published (`itemCount`, `projectId`).
 *
 * `proposalCount` arrives BESIDE `itemCount`, never instead of it (see the
 * rename note at the top of this module).
 */
export const mcpPlanOutcomeSchema = planOutcomeSchema.extend({
  projectId: z.string(),
  /** The pre-11.6 name for `proposalCount`. Kept so no caller breaks. */
  itemCount: z.number().int(),
});
export type McpPlanOutcome = z.infer<typeof mcpPlanOutcomeSchema>;

/** Map a plan outcome — the shared half through v1's presenter. */
export function presentMcpPlanOutcome(outcome: PlanOutcomeDto): McpPlanOutcome {
  return {
    ...presentPlanOutcome(outcome),
    projectId: outcome.projectId,
    itemCount: outcome.itemCount,
  };
}

/** The `get_plan_status` payload, probed against the shared outcome. */
export const planOutcomePayload = definePayload({
  schema: mcpPlanOutcomeSchema as unknown as z.ZodType<McpPlanOutcome>,
  probes: [{ resource: 'PlanOutcome', select: (p) => [p] }],
});

/**
 * A PLAN with its proposals.
 *
 * A NARROWING of v1's `planSchema` (`.omit({ proposals, proposalCount })`) plus
 * the MCP payload's own `items` / `itemCount`. It is a narrowing rather than a
 * widening for one honest reason: v1's `proposals` carry a `workItemKey`
 * resolved through a `keyOfId` lookup the v1 route performs and this tool does
 * not. Publishing that field here would mean either making a read this tool has
 * never made, or emitting `null` for every proposal that HAS a work item —
 * a field that lies. Neither is a change this card's boundary permits, so the
 * proposal rows stay MCP's own and the divergence is DECLARED here rather than
 * discovered later.
 */
export const mcpPlanSchema = planSchema.omit({ proposals: true, proposalCount: true }).extend({
  projectId: z.string(),
  itemCount: z.number().int(),
  /** Who decided the plan. MCP has always published it; v1 does not. */
  decidedById: z.string().nullable(),
  items: z.array(z.unknown()),
});
export type McpPlan = z.infer<typeof mcpPlanSchema>;

/** Map a plan — the shared envelope fields through v1's shape. */
export function presentMcpPlan(plan: PlanWithItemsDto): McpPlan {
  return {
    id: plan.id,
    status: plan.status,
    origin: plan.origin,
    title: plan.title,
    summary: plan.summary,
    sourceJobId: plan.sourceJobId,
    createdAt: plan.createdAt,
    plannedAt: plan.plannedAt,
    decidedAt: plan.decidedAt,
    projectId: plan.projectId,
    itemCount: plan.itemCount,
    decidedById: plan.decidedById,
    items: plan.items,
  };
}

/** The `get_plan` payload. No probe — see the narrowing note above. */
export const planPayload = definePayload({
  schema: mcpPlanSchema as unknown as z.ZodType<McpPlan>,
  probes: [],
});

/** A planning CONVERSATION — v1's `PlanSession`, which the MCP payload matches. */
export const planSessionPayload = definePayload({
  schema: planSessionSchema as unknown as z.ZodType<z.infer<typeof planSessionSchema>>,
  probes: [{ resource: 'PlanSession', select: (p) => [p] }],
});

/** Map a plan session — v1's own presenter, unchanged. */
export function presentMcpPlanSession(
  session: Parameters<typeof presentPlanSession>[0],
): z.infer<typeof planSessionSchema> {
  return presentPlanSession(session);
}

/**
 * The ACTIVITY page.
 *
 * The ENVELOPE stays MCP's own — including the `all` view's cursor, which is an
 * OPAQUE COMPOSITE over two sources on both surfaces. Nothing here describes it
 * in a way that would invite a client to construct, parse or merge one; it is a
 * string the server issued and the client hands back.
 */
export const activityPagePayload = definePayload({
  schema: z
    .object({ nextCursor: z.string().nullable() })
    .catchall(z.unknown()) as unknown as z.ZodType<
    { nextCursor: string | null } & Record<string, unknown>
  >,
  probes: [],
});

/**
 * `mark_integrated`'s result.
 *
 * The tool returns the whole `WorkItemDto`, so the payload REUSES the work-item
 * write shape 11.6.3 already declared — one expression, not a second work-item
 * description. That shape carries every field `integrationResultSchema`
 * requires (`key`, `status`, `sessionBranch`, `updatedAt` and the three
 * implementation-provenance columns), so it VALIDATES against v1's result and
 * the drift guard has something real to compare.
 *
 * v1's own endpoint deliberately returns the NARROW result instead — "did the
 * integration land, and where?" — and that difference is legitimate: the two
 * surfaces answer the same question, and MCP answers it with more. What matters
 * is that the overlap is one schema, which is what the probe asserts.
 */
export const markIntegratedPayload = definePayload({
  schema: mcpWorkItemSchema as unknown as z.ZodType<McpWorkItem>,
  probes: [{ resource: 'IntegrationResult', select: (p) => [p] }],
});

export { integrationResultSchema };
