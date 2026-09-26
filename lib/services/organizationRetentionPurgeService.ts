import { purgeOrgRetained } from '@/lib/ai/motirAiClient';
import { retentionCutoff } from '@/lib/organizations/deletion';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE RETENTION PURGE (Story MOTIR-6306 · MOTIR-6401;
// `docs/decisions/organization-deletion.md` §7). The erasure sweep leaves an
// erased organization as a TOMBSTONE — the scrubbed `organization` row and its
// `CiPeriodCharge` rows — because the law requires the billing record for seven
// years (`ORGANIZATION_BILLING_RETENTION_YEARS`). Once that has run, this removes
// it, in both repositories, and never earlier.
//
// motir-ai FIRST: its retained ledger (`AiOrganization` tombstone, credit ledger
// and transactions, Stripe ids) is purged before ours, so a crash never leaves
// motir-ai holding a ledger for an org motir-core has forgotten. A failure there
// stops that org and the next run retries it; our tombstone stays until then.
//
// Then ONE transaction bound to the org: the deletion requests go first (their
// FK is `Restrict`; their notices cascade), then the org row, whose cascades take
// the billing rows. The delete is predicated on `erasedAt` being set, so a live
// organization cannot be removed here even if a request somehow named it.
//
// The work set is `listErasedBefore(now − 7 years)`: an erased REQUEST whose
// `erasedAt` is older than the cutoff. A live org has no erased request, so the
// query cannot select one.

/** How many tombstones one run considers; the rest are the next run's. */
const PURGE_BATCH = 50;

export interface RetentionPurgeDeps {
  purgeAi: (organizationId: string) => Promise<unknown>;
}

const LIVE_DEPS: RetentionPurgeDeps = {
  purgeAi: (id) => purgeOrgRetained(id),
};

export interface RetentionPurgeSummary {
  scanned: number;
  purged: number;
  failed: number;
  failures: Array<{ organizationId: string; error: string }>;
}

export const organizationRetentionPurgeService = {
  /**
   * Purge every organization whose retention ended before `now` (at most
   * {@link PURGE_BATCH}). A per-org failure is recorded in the summary and
   * never fails the run.
   */
  async runDue(
    now: Date = new Date(),
    deps: RetentionPurgeDeps = LIVE_DEPS,
    limit: number = PURGE_BATCH,
  ): Promise<RetentionPurgeSummary> {
    const summary: RetentionPurgeSummary = { scanned: 0, purged: 0, failed: 0, failures: [] };
    const due = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.listErasedBefore(retentionCutoff(now), limit, tx),
    );
    summary.scanned = due.length;

    for (const request of due) {
      const { organizationId } = request;
      try {
        await deps.purgeAi(organizationId);
        const deleted = await withOrgServiceWriteContext(organizationId, async (tx) => {
          await organizationDeletionRequestRepository.deleteAllByOrganization(organizationId, tx);
          return organizationRepository.deleteErasedById(organizationId, tx);
        });
        if (deleted) summary.purged += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.failed += 1;
        summary.failures.push({ organizationId, error: message });
        console.error('[organizationRetentionPurge] purge failed; the next run retries it', {
          organizationId,
          err,
        });
      }
    }
    return summary;
  },
};
