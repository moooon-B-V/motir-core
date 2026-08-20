import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { planTargetKeyResolver, presentPlan } from '@/lib/api/v1/workLoop/schema';
import { PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/plan-approval (MOTIR-3021 / MOTIR-3023) — the
// public entrance `motir auto --auto-approve-replan` drives, specified in full
// by `docs/decisions/run-findings-protocol.md` Q2.
//
// ── ADDRESSED BY THE CARD, and that IS the bound ────────────────────────────
// The caller is a loop whose AGENT submitted the plan, in a sandbox, with
// `motir plan --detach <KEY>`. The plan id came back on that agent's stdout,
// which the loop streams to the terminal and never captures — so a
// plan-addressed route would have meant either a second read to discover the id
// or a scrape of the agent's output, and the anchoring check would have been a
// check on data the caller supplied. Addressed by the CARD, there is no way to
// name a plan that is not this card's: the server derives it, through
// `buildScope([key])` → the anchored conversation → its last submitted job →
// the plan that job produced.
//
// ── This REVERSES a deliberate absence, and the reversal is the ADR's ───────
// Approval was unreachable off the session surface on purpose: several places in
// this codebase said so, including the comment on the browser route this
// mirrors. Q2 makes the trade and sets the bounds; this route implements them
// and nothing more.
//
// ── NOT AN MCP TOOL, and that is the sharpest bound in the whole design ─────
// MCP is the AGENT's surface. A tool would put approval in reach of the
// credential a sandboxed agent holds, and the agent is the one party that must
// never approve its own re-plan — the approving party is the OPERATOR's loop.
// Expressing that structurally beats expressing it as a check, and it costs
// nothing: the CLI speaks `/api/v1` exclusively. It is enforced from the other
// side too, by accident of good design: `CLI_TOKEN_GRANT` omits the key this
// route declares, so a token minted FOR a dispatched agent cannot reach it at
// all (MOTIR-3051). Do not widen that grant to "fix" it.
//
// ⚠️ THAT BOUND GOT STRONGER, NOT WEAKER, WHEN THE KEY CHANGED (MOTIR-3188).
// The sentence above named `ai:view_plan`, and the omission it relied on was one
// entry missing from one grant. This route now declares `ai:decide_plan`, which
// `CLI_TOKEN_GRANT` also omits AND which no MCP tool asserts at all — so a
// sandboxed agent's credential cannot reach approval by any route, and could not
// even if somebody widened that grant to the full author key.
//
// ── ONE service call, and the bound is inside it ───────────────────────────
// `plansService.approvePlanForWorkItem` resolves the plan and delegates to the
// shipped `approvePlan` — no second approval path, no re-derived validation, and
// the confirmation gate untouched. HTTP only up here (CLAUDE.md 4-layer).

// The key the SERVICE itself asserts (`approvePlan` →
// `projectAccessService.assertPermission(…, 'ai:decide_plan')`) — the key that
// gates the plan DECISIONS. Declared rather than minted: a new scope for a
// decision that already has one would give a caller two ways to be allowed, and
// one of them would drift.
//
// ⚠️ IT WAS `ai:view_plan` WHEN THIS ROUTE SHIPPED, and the rule that picked it
// is unchanged — a route names the key its own service asserts. MOTIR-3188 split
// that key in two, because it gated no view and held both AUTHOR and DECIDE: an
// admin ticking a switch labelled "view" on the Roles & permissions grid was
// granting bulk work-item creation. `approvePlan` moved to the DECIDE half, so
// this declaration followed it. Nothing about the route's shape, statuses or
// error codes changed, and every built-in role resolves the two keys
// identically.
//
// ⚠️ The reasoning lives HERE, above the export, because the registry guards
// read this file as SOURCE — `declaredPermissionByMethod` matches
// `withV1Route<…>({ permission: … }` with only whitespace between the paren and
// the brace, so a comment in that gap makes the route read as declaring NO
// permission (`tests/api/v1/openapi-registry.test.ts`). Every other v1 route is
// written this way for the same reason.
export const POST = withV1Route<{ key: string }>({ permission: 'ai:decide_plan' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);

  let plan;
  try {
    plan = await plansService.approvePlanForWorkItem(projectId, identifier, ctx.service);
  } catch (err) {
    // ⚠️ THE REFUSAL TEACHES, and this one has to (MOTIR-3025). An agent submits
    // its re-plan with `--detach` and exits within milliseconds, so a loop that
    // approves immediately meets a plan that is still `generating` — the planner
    // has not finished writing it. That is *not yet*, and it is the one 409 a
    // caller should WAIT on; `approved` / `declined` mean somebody already
    // decided and it must stop. The two are one status apart and
    // indistinguishable in the sentence, so the status rides the envelope as
    // DATA — the same shape `POST …/transitions` uses for its allowed targets,
    // and for the same reason: §8 forbids parsing prose.
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json(
        { code: err.code, error: err.message, planStatus: err.actual },
        { status: 409 },
      );
    }
    throw err;
  }

  // The same presentation `GET /api/v1/plans/{planId}` returns, resolved the
  // same bounded way — so a client that read a plan before approving it does
  // not have to learn a second shape to read what became of it. It also
  // carries the plan's own id, which is how a caller that never knew it can
  // report WHAT it approved.
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
