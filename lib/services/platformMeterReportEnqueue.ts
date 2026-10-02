import type { ContainerAccrual, ContainerUsage, UsageMeter } from '@motir/orchestrator';
import { isCloudBilling } from '@/lib/billing/availability';
import { sendSystemEvent } from '@/lib/jobs/sendEvent';

/**
 * The two ENQUEUE doors of the platform meter report (Story MOTIR-727 ·
 * MOTIR-5286, MOTIR-7294), apart from `platformMeterReportService` on purpose.
 * Only the event leaves here; the job re-reads the row and reports it.
 *
 * ⚠️ NOT FROM INSIDE `ciFleetCostMeterService`. That service is on the fleet-cost
 * READ graph, which must never reach the motir-ai client
 * (`tests/ciFleet/fleetCostStoryGate.test.ts`, AC 5) — and `sendEvent` reaches it
 * through the job registry. So the settle's report is enqueued by
 * `withPlatformMeterReport`, the meter the orchestrator's usage sink is bound to.
 */
export const platformMeterReportEnqueue = {
  /**
   * Enqueue ONE settled container's report. Called by the settle path after its
   * transaction commits; a failed enqueue is swallowed by `sendSystemEvent` and can
   * never fail the settle. Off-cloud there is no fleet and nothing to report.
   */
  async container(containerProvider: string, handleId: string): Promise<void> {
    if (!isCloudBilling()) return;
    await sendSystemEvent('system.platform-meter-report', { containerProvider, handleId });
  },

  /** Enqueue ONE charged storage day's report, after its charge commits. */
  async storage(storageChargeId: string): Promise<void> {
    if (!isCloudBilling()) return;
    await sendSystemEvent('system.platform-meter-report', { storageChargeId });
  },
};

/**
 * The fleet meter, wrapped so a settle that COMMITS (`recorded`) enqueues its
 * report. A duplicate teardown, an off-cloud meter or a throw enqueues nothing.
 * `lib/orchestrator` binds its usage sink to this, so every container the fleet
 * tears down is reported — and the meter service itself imports no job.
 */
export function withPlatformMeterReport<
  M extends {
    recordContainerUsage(usage: ContainerUsage): Promise<{ outcome: string }>;
    recordContainerAccrual(accrual: ContainerAccrual): Promise<unknown>;
  },
>(meter: M): Omit<UsageMeter, 'recordContainerUsage'> & Pick<M, 'recordContainerUsage'> {
  return {
    async recordContainerUsage(usage) {
      const result = await meter.recordContainerUsage(usage);
      if (result.outcome === 'recorded') {
        await platformMeterReportEnqueue.container(usage.provider, usage.handleId);
      }
      return result;
    },
    recordContainerAccrual: (accrual) => meter.recordContainerAccrual(accrual),
  } as Omit<UsageMeter, 'recordContainerUsage'> & Pick<M, 'recordContainerUsage'>;
}
