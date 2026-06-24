import { Prisma } from '@prisma/client';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { OrganizationNotFoundError } from '@/lib/organizations/errors';
import { toScaledTrackerStateDTO, toAiIncludedSeatDTO } from '@/lib/mappers/billingMappers';
import type { SetScaledTrackerStateInput } from '@/lib/billing/scaledTrackerState';
import type { SetAiIncludedSeatInput } from '@/lib/billing/aiIncludedSeat';
import type { ScaledTrackerStateDTO, AiIncludedSeatDTO } from '@/lib/dto/billing';

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

export const billingPropagationService = {
  /**
   * Persist the org's scaled-tracker subscription state (or clear it with
   * `null`). Returns the confirmation DTO. Throws `OrganizationNotFoundError`
   * (→ 404) when the org does not exist (or is RLS-unreachable).
   */
  async setScaledTrackerState(input: SetScaledTrackerStateInput): Promise<ScaledTrackerStateDTO> {
    try {
      const org = await withOrgServiceWriteContext(input.organizationId, (tx) =>
        organizationRepository.updateScaledTrackerState(
          input.organizationId,
          input.scaledTrackerSubscription,
          tx,
        ),
      );
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
      const org = await withOrgServiceWriteContext(input.organizationId, (tx) =>
        organizationRepository.updateAiIncludedSeat(input.organizationId, input.included, tx),
      );
      return toAiIncludedSeatDTO(org);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new OrganizationNotFoundError(input.organizationId);
      }
      throw err;
    }
  },
};
