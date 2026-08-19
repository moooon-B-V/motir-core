import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { planTargetKeyResolver, presentPlan } from '@/lib/api/v1/workLoop/schema';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/plans/{planId}/approval (MOTIR-3021) — the public entrance
// `motir auto --auto-approve-replan` drives, specified in full by
// `docs/decisions/run-findings-protocol.md` Q2.
//
// ── This REVERSES a deliberate absence, and the reversal is the ADR's ────────
// Approval was unreachable off the session surface on purpose: four places in
// this codebase said so, and one of them is the comment on the browser route
// this mirrors. Q2 makes the trade and sets the bounds; this route implements
// them and nothing more. It is not the place to re-open the question.
//
// ── NOT AN MCP TOOL, and that is the sharpest bound in the whole design ──────
// MCP is the AGENT's surface. A tool would put approval in reach of the
// credential a sandboxed agent holds, and the agent is the one party that must
// never approve its own re-plan — the approving party is the OPERATOR's loop.
// Expressing that structurally beats expressing it as a check, and it costs
// nothing: the CLI speaks `/api/v1` exclusively. It is enforced from the other
// side too, by accident of good design: `CLI_TOKEN_GRANT` omits `ai:view_plan`,
// so a token minted FOR a dispatched agent cannot reach this route at all
// (MOTIR-3051). Do not widen that grant to "fix" it.
//
// ── ONE service call, and the bound is inside it ────────────────────────────
// `plansService.approvePlanForWorkItem` adds the anchoring check and delegates
// to the shipped `approvePlan` — no second approval path, no re-derived
// validation, and the confirmation gate untouched. HTTP only up here (CLAUDE.md
// 4-layer): parse the body, call one method, let the wrapper map the typed
// errors through `DOMAIN_ERROR_STATUS`.

/** The body: the card this approval is being made on behalf of. */
function parseWorkItemKey(body: unknown): string {
  const key = (body as { workItemKey?: unknown } | null)?.workItemKey;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new InvalidRequestError(
      'INVALID_REQUEST',
      'A `workItemKey` naming the work item this approval is made for is required.',
    );
  }
  return key.trim();
}

// ── THE PERMISSION, and why the declaration below carries no comment ────────
// `ai:view_plan` is the key the SERVICE itself asserts (`approvePlan` →
// `projectAccessService.assertPermission(…, 'ai:view_plan')`) and the key
// `lib/mcp/toolPermissions.ts` already records as gating the plan DECISIONS.
// Declared rather than minted: a new scope for a decision that already has one
// would give a caller two ways to be allowed, and one of them would drift.
//
// ⚠️ The reasoning lives HERE, above the export, because the registry guards
// read this file as SOURCE — `declaredPermissionByMethod` matches
// `withV1Route<…>({ permission: … }` with only whitespace between the paren and
// the brace, so a comment in that gap makes the route read as declaring NO
// permission (`tests/api/v1/openapi-registry.test.ts`). Every other v1 route is
// written this way for the same reason.
export const POST = withV1Route<{ planId: string }>({ permission: 'ai:view_plan' }, async (ctx) => {
  let body: unknown = null;
  try {
    body = await ctx.req.json();
  } catch {
    // An absent or unparseable body is the same missing-key failure as an
    // empty one — the caller's fix is identical, so the message is too.
    body = null;
  }
  const workItemKey = parseWorkItemKey(body);

  const plan = await plansService.approvePlanForWorkItem(
    ctx.params.planId,
    workItemKey,
    ctx.service,
  );

  // The same presentation `GET /api/v1/plans/{planId}` returns, resolved the
  // same bounded way — so a client that read the plan before approving it does
  // not have to learn a second shape to read what became of it.
  const targetIds = [
    ...new Set(plan.items.map((item) => item.workItemId).filter((id): id is string => id !== null)),
  ];
  const refs = await workItemsService.resolveReferenceSummaries(
    { ids: targetIds, keys: [] },
    plan.projectId,
    ctx.service,
  );
  return NextResponse.json(presentPlan(plan, planTargetKeyResolver(refs)));
});
