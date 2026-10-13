import { Prisma } from '@/generated/prisma/client';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { toScaledTrackerStateDTO, toAiIncludedSeatDTO } from '@/lib/mappers/billingMappers';
import type { SetScaledTrackerStateInput } from '@/lib/billing/scaledTrackerState';
import type { SetAiIncludedSeatInput } from '@/lib/billing/aiIncludedSeat';
import type { ScaledTrackerStateDTO, AiIncludedSeatDTO } from '@/lib/dto/billing';
import { agentInstanceLapseService } from '@/lib/services/agentInstanceLapseService';
import { agentInstanceClock } from '@/lib/services/agentInstanceActivityService';
import { enqueueScaledTrackerSeatSync } from '@/lib/billing/seatSync';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Billing-propagation service (Story 8.1.4c) — the motir-core consumer side of
// scaled-tracker subscription propagation. motir-ai's Stripe webhook (8.1.4b)
// dispatches `tracker_*` subscription events through its coreClient (8.1.4d),
// which POSTs to the inbound route; the route hands the validated input here.
//
// This service owns the single write transaction (per CLAUDE.md): it binds the
// active-org GUC for the target org and updates the column through the repo. No
// Stripe SDK, no ledger — pure subscription-state propagation. Idempotent:
// re-applying the same input re-writes the same value (a no-op result), so a
// retried webhook delivery is safe.
//
// Both pushes change what the org's tracker seats should bill (MOTIR-8403): the
// AI-included seat nets one member out of the billed quantity, and only an
// ACTIVE seat subscription bills at all. So when either push changes the stored
// value, it enqueues the existing seat resync after the write commits, and the
// absolute target reaches motir-ai at once instead of at the next membership
// change. An unchanged push (a redelivered webhook) enqueues nothing.

/** The part of the seat subscription the seat sync reads: is it billing? */
function seatSubscriptionStatus(value: unknown): string | null {
  return (value as ScaledTrackerSubscription | null)?.status ?? null;
}

/**
 * Best-effort, post-commit: the push has already committed, so a failed enqueue
 * is logged and never fails it. The next membership change still converges.
 */
async function resyncSeats(organizationId: string): Promise<void> {
  try {
    await enqueueScaledTrackerSeatSync(organizationId);
  } catch (err) {
    console.error('[billing] seat resync enqueue failed after a billing push', {
      organizationId,
      err,
    });
  }
}

export const billingPropagationService = {
  /**
   * Persist the org's scaled-tracker subscription state (or clear it with
   * `null`). Returns the confirmation DTO. Throws `OrganizationNotFoundError`
   * (→ 404) when the org does not exist (or is RLS-unreachable).
   */
  async setScaledTrackerState(input: SetScaledTrackerStateInput): Promise<ScaledTrackerStateDTO> {
    try {
      const { before, org } = await withOrgServiceWriteContext(input.organizationId, async (tx) => {
        const prior = await organizationRepository.findByIdInTx(input.organizationId, tx);
        const updated = await organizationRepository.updateScaledTrackerState(
          input.organizationId,
          input.scaledTrackerSubscription,
          tx,
        );
        return { before: prior?.scaledTrackerSubscription ?? null, org: updated };
      });
      if (
        seatSubscriptionStatus(before) !== seatSubscriptionStatus(org.scaledTrackerSubscription)
      ) {
        await resyncSeats(input.organizationId);
      }
      return toScaledTrackerStateDTO(org);
    } catch (err) {
      // P2025 = "record to update not found": the org id is absent, or RLS hid
      // it. Either way the caller gets a 404 (the no-leak rule — never reveal
      // existence across the tenant boundary).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new OrganizationNotFoundError(input.organizationId);
      }
      throw err;
    }
  },

  /**
   * Set the org's AI-included-seat flag (8.1.24) — true while a PAID Motir AI
   * plan is active (it bundles 1 Motir seat → lifts the §4 caps), false clears
   * it. Same write contract as {@link setScaledTrackerState}: one bound-context
   * transaction, idempotent, `OrganizationNotFoundError` (→ 404) on a missing/
   * RLS-hidden org.
   */
  async setAiIncludedSeat(input: SetAiIncludedSeatInput): Promise<AiIncludedSeatDTO> {
    try {
      const { before, org } = await withOrgServiceWriteContext(input.organizationId, async (tx) => {
        const prior = await organizationRepository.findByIdInTx(input.organizationId, tx);
        const updated = await organizationRepository.updateAiIncludedSeat(
          input.organizationId,
          input.included,
          tx,
        );
        return { before: prior?.aiIncludedSeat ?? null, org: updated };
      });
      // The seat is on exactly while the org holds a paid AI plan, so this push
      // is also the plan's lapse and its return (`agent-instance-storage.md` §4,
      // MOTIR-6921): after the seat has committed, schedule or clear the org's
      // agents' deletion. Motir's own organisations are never scheduled (§5).
      // The lapse is stamped on the agent clock the sweep reads its due dates
      // against, so the two cannot disagree (MOTIR-8071).
      if (input.included) await agentInstanceLapseService.clearLapse(input.organizationId);
      else
        await agentInstanceLapseService.recordLapse(input.organizationId, agentInstanceClock.now());
      // A plan starting, ending or moving flips this flag, and the flag decides
      // whether the first member is billed: resync the seats now (MOTIR-8403).
      if (before !== org.aiIncludedSeat) await resyncSeats(input.organizationId);
      return toAiIncludedSeatDTO(org);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new OrganizationNotFoundError(input.organizationId);
      }
      throw err;
    }
  },
};
