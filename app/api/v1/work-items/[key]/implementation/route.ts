import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  implementationReportBodySchema,
  presentImplementationReport,
  toProvenanceInput,
} from '@/lib/api/v1/workLoop/schema';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/implementation (Story 11.5 · MOTIR-2421) —
// record WHAT BUILT a work item, said on its own.
//
// ── Why this is not a field on the integration endpoint ─────────────────────
// It already was, and that is the bug. `POST …/integration` requires
// `sessionBranch` in its body, so the only way to say "this was built by X on
// model Y" was to also say "and it is integrated on branch Z". For `motir
// batch` — one pull request per item, off `main` — the second half is FALSE,
// so it recorded nothing at all and every card it ran carries a null triple.
// "What built this" and "where is it integrated" are independent facts.
//
// ── ⚠️ There is no `sessionBranch` here, and the body is STRICT ─────────────
// A branch sent to this route is a 422, not an ignored field. That is
// deliberate: `isOpenBlocker` reads a recorded branch as evidence a blocker is
// satisfied, so stamping one would make an item stop blocking its dependents
// with nothing merged, and `motir done --session` would then sweep it up. The
// short road — invent a branch so the existing call can be reused — is the one
// a caller reaches for first, and it must fail loudly rather than half-work.
//
// ── It moves no status ──────────────────────────────────────────────────────
// Unlike `…/integration`, which transitions to In review as part of what it
// asserts. The caller has already put the item where it belongs (`motir batch`
// transitions when the agent opens its own pull request); this adds a fact
// about the work, not a claim about its state. The response echoes `status` and
// `sessionBranch` unchanged so a client can SEE that.
//
// ── The `integration` scope, same as its siblings ───────────────────────────
// `lib/mcp/scopes.ts` defines it as "External-agent integration writes", which
// is exactly the actor here: an agent runner reporting what it ran as. A token
// with `work_items:write` and not `integration` is refused, as on both siblings.

export const POST = withV1Route<{ key: string }>({ scope: 'integration' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, implementationReportBodySchema);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  // Sharing `toProvenanceInput` with the two close-out routes is what keeps the
  // three seams agreeing about a PARTIAL report (MOTIR-2447): an omitted field
  // means "I do not know" and leaves the stored value alone, rather than
  // erasing what an earlier report recorded.
  const provenance = toProvenanceInput(body) ?? {};

  const dto = await workItemsService.reportImplementation(item.id, ctx.service, provenance);

  return NextResponse.json(presentImplementationReport(dto));
});
