import { sendSystemEvent } from '@/lib/jobs/sendEvent';
import { isCloudBilling } from '@/lib/billing/availability';

// Best-effort, POST-COMMIT enqueue of a scaled-tracker seat-quantity resync for
// an org whose membership just changed (Subtask 8.1.12). The single chokepoint
// every org-membership add/remove path calls so the seat→membership invariant is
// upheld uniformly (the "sweep ALL membership creators" rule) — direct org
// add/remove (organizationsService) AND the upward workspace auto-joins
// (workspacesService.addMember / workspaceInvitesService.accept).
//
// MUST be called AFTER the membership transaction commits: membership is the
// source of truth and the seat sync is a SIDE EFFECT that must never fail or roll
// back the add/remove (PROD-443 — a notification/billing side effect coupling a
// committed mutation to its own success turns every such mutation into a 500 on a
// transport blip). So a failed enqueue is swallowed + logged, never propagated.
//
// Off-cloud there is no billing at all, so it is a no-op (no enqueue) — this is
// the cheap gate that keeps self-hosted + local/test paths free of background-queue
// traffic. On cloud it enqueues the idempotent `system.billing-seat-sync` job,
// which is the AUTHORITATIVE gate: it re-derives the count and no-ops for any org
// without an active scaled-tracker subscription (the common case).
export async function enqueueScaledTrackerSeatSync(organizationId: string): Promise<void> {
  if (!isCloudBilling()) return;
  // Through `sendSystemEvent`, not `inngest.send` (MOTIR-3456): the per-job
  // cutover switch is read there, so an emitter that calls the client directly
  // is an emitter the switch cannot route.
  //
  // NO local try/catch any more, and that is not a dropped guarantee — it is the
  // removal of a second copy of the same policy. `sendSystemEvent` is
  // best-effort by construction: a transport failure (the queue unreachable /
  // unconfigured) is swallowed and logged there, so it can never fail the
  // already-committed membership change. The absolute recompute-from-truth
  // design still means a later membership change (or a manual replay) re-derives
  // the correct quantity — no drift accumulates.
  await sendSystemEvent('system.billing-seat-sync', { organizationId });
}
