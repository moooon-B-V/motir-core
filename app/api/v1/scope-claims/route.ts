import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentScopeClaim, scopeClaimBodySchema } from '@/lib/api/v1/workLoop/schema';
import { projectsService } from '@/lib/services/projectsService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';

// POST /api/v1/scope-claims (MOTIR-3049) — the ATOMIC SCOPE claim.
//
// ── Why the scope rides in the BODY, and why there is ONE route ─────────────
// The two claimable scopes are named by different things: a container is a
// `MOTIR-<n>` key, and a sprint is *the active one of a project*, named by a
// project key. Neither is a path parameter of the other, so a path-addressed
// design is necessarily TWO endpoints — and the two would share the lock, the
// deterministic order, the category re-assert and every one of the six
// outcomes, which is to say they would share everything except the two lines
// that read the request. One operation with a discriminated body keeps that
// single implementation single. `POST /api/v1/sessions/complete` is the shipped
// precedent for a write addressed by its body.
//
// ── The route decides NOTHING ──────────────────────────────────────────────
// It resolves an identifier to what the services address things by and shapes a
// response. The validation, the shape rule, the lock order, the category
// re-assert, the all-or-nothing transaction and the outcome vocabulary all live
// in `scopeClaimService.claimScope`.
//
// ── A REFUSED claim is a 200 ───────────────────────────────────────────────
// Four of the six outcomes are ordinary states a dispatcher meets, and two of
// them (`wrong_shape`, `not_finishable`) are FINDINGS whose correct response is
// to submit a re-plan — a client that had to parse an error body to learn its
// story needs re-shaping would be reading a diagnosis out of a failure. Real
// failures keep their statuses: 404 for an unknown or cross-workspace key or
// project, 409 for a project with no active sprint, 422 for a malformed one.
export const POST = withV1Route({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, scopeClaimBodySchema);

  // Both arms resolve through the SAME services every other keyed read uses, so
  // a key in another workspace is refused here exactly as `get_work_item`
  // refuses it — 404, indistinguishable from one that never existed.
  const input =
    body.kind === 'work_item'
      ? { kind: 'work_item' as const, ...(await resolveWorkItemKey(body.key, ctx.service)) }
      : {
          kind: 'sprint' as const,
          projectId: (await projectsService.getByKey(body.projectKey, ctx.service)).id,
        };

  const claim = await scopeClaimService.claimScope(input, ctx.service);
  return NextResponse.json(presentScopeClaim(claim));
});
