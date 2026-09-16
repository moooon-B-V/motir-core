import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentWorkItemRepairClaim } from '@/lib/api/v1/workLoop/schema';
import { workItemRepairService } from '@/lib/services/workItemRepairService';

// POST /api/v1/work-items/{key}/repair (Story MOTIR-5460 · MOTIR-5464) — the
// REPAIR CLAIM `motir fix <key>` makes: one fixing agent at a time on an
// `implemented` card's red pull requests.
//
// ── The route decides NOTHING ───────────────────────────────────────────────
// The lock, the refusal order, the run it opens and the outcome vocabulary all
// live in `workItemRepairService.claimRepair`, which owns the one transaction.
// This file resolves a key and shapes a response.
//
// ── A refused repair is a 200 ───────────────────────────────────────────────
// `taken` and `not_repairable` are ordinary answers a person running the command
// meets, for the reason the keyed claim's route gives. Real failures keep their
// statuses: 404 for an unknown or cross-workspace key, 422 for a malformed one.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const claim = await workItemRepairService.claimRepair(projectId, identifier, ctx.service);
  return NextResponse.json(presentWorkItemRepairClaim(claim));
});
