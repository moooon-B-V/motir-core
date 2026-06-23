import { inngest } from '@/lib/jobs/client';
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
// the cheap gate that keeps self-hosted + local/test paths free of Inngest
// traffic. On cloud it enqueues the idempotent `system.billing-seat-sync` job,
// which is the AUTHORITATIVE gate: it re-derives the count and no-ops for any org
// without an active scaled-tracker subscription (the common case).
export async function enqueueScaledTrackerSeatSync(organizationId: string): Promise<void> {
  if (!isCloudBilling()) return;
  try {
    await inngest.send({ name: 'system.billing-seat-sync', data: { organizationId } });
  } catch (err) {
    // Transport failure (Inngest unreachable / unconfigured) must NOT fail the
    // already-committed membership change. Drop + log; the absolute recompute-
    // from-truth design means a later membership change (or a manual replay)
    // re-derives the correct quantity — no drift accumulates.
    console.error(
      `enqueueScaledTrackerSeatSync(${organizationId}) failed to enqueue; the membership ` +
        `change committed but the seat resync was dropped:`,
      err,
    );
  }
}
