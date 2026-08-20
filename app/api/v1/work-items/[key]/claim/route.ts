import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentWorkItemClaim } from '@/lib/api/v1/workLoop/schema';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/claim (MOTIR-2961) — the ATOMIC keyed claim.
//
// ── Why this is a `/api/v1` op and not an MCP tool ──────────────────────────
// `packages/cli` retired its MCP transport in 11.5.6 and every client method now
// goes through `this.v1.request`. An MCP-only claim would have fixed the runbook
// path and left `motir run` / `next` / `batch` / `auto` — the majority of
// dispatch, and the shape a hosted orchestrator uses, since it is handed a work
// item BY KEY rather than asking for whatever is free — on the advisory
// assignment permanently. (A `claim_work_item` MCP tool exists too, and calls
// the SAME service method: one implementation, one lock.)
//
// ── The route decides NOTHING ───────────────────────────────────────────────
// The lock, the category re-assert, the assignment, the transition and the
// outcome vocabulary all live in `workItemsService.claimWorkItem`, which owns
// the single transaction. This file resolves a key and shapes a response.
//
// ── A LOST claim is a 200 ───────────────────────────────────────────────────
// Three of the four outcomes are ordinary states a dispatcher meets on the happy
// path: it is resuming its own interrupted run (`mine`), a sibling was faster
// (`taken`), or the card is already finished (`not_claimable`). Making two of
// those HTTP failures would force a client to parse an error body to learn it
// may simply proceed — the same reasoning `POST /api/v1/sessions/complete` gives
// for reporting per-item outcomes rather than failing. Real failures keep their
// statuses: 404 for an unknown or cross-workspace key, 422 for a malformed one.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const claim = await workItemsService.claimWorkItem(projectId, identifier, ctx.service);
  return NextResponse.json(presentWorkItemClaim(claim));
});
