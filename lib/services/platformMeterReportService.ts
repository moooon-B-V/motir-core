import {
  reportPlatformMeter,
  type PlatformMeterReport,
  type PlatformMeterWorkload,
} from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import { sendSystemEvent } from '@/lib/jobs/sendEvent';
import {
  ciContainerUsageRepository,
  type CiContainerWorkload,
} from '@/lib/repositories/ciContainerUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * The PLATFORM METER REPORT (Story MOTIR-727 · MOTIR-5286) — every settled fleet
 * container's seconds and Motir cost, reported to motir-ai's platform usage rollup
 * (`POST /v1/platform/meter`, motir-ai MOTIR-7290), which every console spend sheet
 * reads. motir-core owns the fleet meter, so it is the side that reports
 * (motir-ai `docs/credit-model.md` §4a, *the meter's owner converts*).
 *
 * ⚠️ NOT A CHARGE. Credits move on the debit routes, as they always have. This is
 * usage and cost only — and for code indexing, which Motir does not charge for, it
 * is the ONLY place the figure leaves motir-core.
 *
 * ⚠️ IT NEVER TOUCHES THE SETTLE. The report is a job enqueued AFTER the meter row
 * commits (`enqueueContainerReport`, best-effort like every post-commit emit), and
 * the job re-reads the row and sends it, so:
 *   - a motir-ai outage throws inside the JOB, whose `idempotent` retry policy owns
 *     it — the settle and its charge are long committed;
 *   - every attempt sends the row's own id as the idempotency key, so a retry, a
 *     replayed event or a duplicate teardown adds nothing at the receiver.
 */

/** The meter's line → the receiver's workload. Explicit because the two
 *  vocabularies differ on the instance line (`instance` vs `agent_instance`). */
export const METER_REPORT_WORKLOAD: Record<CiContainerWorkload, PlatformMeterWorkload> = {
  agent: 'agent',
  instance: 'agent_instance',
  ci: 'ci',
  index: 'index',
};

export type ContainerReportOutcome =
  | { outcome: 'reported'; containerUsageId: string; idempotent: boolean }
  | { outcome: 'not_settled' }
  | { outcome: 'missing' };

export const platformMeterReportService = {
  /**
   * Enqueue ONE settled container's report. Called by the settle path after its
   * transaction commits; a failed enqueue is swallowed by `sendSystemEvent` and can
   * never fail the settle. Off-cloud there is no fleet and nothing to report.
   */
  async enqueueContainerReport(containerProvider: string, handleId: string): Promise<void> {
    if (!isCloudBilling()) return;
    await sendSystemEvent('system.platform-meter-report', { containerProvider, handleId });
  },

  /**
   * The job's body: read the container's settled figure and report it.
   *
   * A row that is absent or not yet settled reports NOTHING — the event is only
   * ever sent for a settle, so either is a stale or foreign event, and a figure
   * that can still move must not be reported as final. Every motir-ai failure
   * THROWS, so the job retries; the receiver is idempotent on the row id.
   */
  async reportContainer(
    containerProvider: string,
    handleId: string,
  ): Promise<ContainerReportOutcome> {
    const row = await withSystemContext((tx) =>
      ciContainerUsageRepository.findForMeterReport(containerProvider, handleId, tx),
    );
    if (!row) return { outcome: 'missing' };
    if (!row.containerStoppedAt) return { outcome: 'not_settled' };

    const report: PlatformMeterReport = {
      kind: 'container',
      containerUsageId: row.id,
      coreOrganizationId: row.organizationId,
      coreWorkspaceId: row.workspaceId,
      coreProjectId: row.projectId,
      workload: METER_REPORT_WORKLOAD[row.workload as CiContainerWorkload],
      billableSeconds: row.billableSeconds,
      // The Decimal's own string — exact, never through a float.
      costUsd: row.costUsd.toFixed(),
      settledAt: row.containerStoppedAt.toISOString(),
    };
    const result = await reportPlatformMeter(report);
    return { outcome: 'reported', containerUsageId: row.id, idempotent: result.idempotent };
  },
};
