import { Prisma } from '@/generated/prisma/client';
import {
  INSTANCE_SNAPSHOT_USD_PER_GB_MONTH,
  INSTANCE_STORAGE_DAYS_PER_MONTH,
  INSTANCE_VOLUME_SIZE_GB,
  INSTANCE_VOLUME_USD_PER_GB_MONTH,
} from '@/lib/agentInstances/config';
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
import { agentInstanceStorageChargeRepository } from '@/lib/repositories/agentInstanceStorageChargeRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

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

export type StorageReportOutcome =
  | { outcome: 'reported'; storageChargeId: string; idempotent: boolean }
  | { outcome: 'not_charged' }
  | { outcome: 'missing' };

/** One UTC day of a 10 GB volume, in GB-seconds — the storage report's usage. */
export const STORAGE_GB_SECONDS_PER_DAY = INSTANCE_VOLUME_SIZE_GB * 24 * 60 * 60;

/**
 * What one agent's storage costs Motir for one UTC day, as a decimal string:
 * (volume + one snapshot copy) × GB × the Fly prices, over the record's 30-day
 * month (`agent-instance-storage.md` §2 — $2.30 / 30). Nine places, a nano-dollar.
 */
export const STORAGE_COST_USD_PER_DAY = new Prisma.Decimal(INSTANCE_VOLUME_USD_PER_GB_MONTH)
  .add(INSTANCE_SNAPSHOT_USD_PER_GB_MONTH)
  .mul(INSTANCE_VOLUME_SIZE_GB)
  .div(INSTANCE_STORAGE_DAYS_PER_MONTH)
  .toDecimalPlaces(9)
  .toFixed();

/** How many rows one backfill batch reads and reports. */
export const METER_BACKFILL_BATCH = 200;

export interface MeterBackfillSummary {
  containers: { reported: number; failed: number };
  storageDays: { reported: number; failed: number };
}

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
    // Accepted — stamped so the backfill never sends it again (MOTIR-7294).
    await withSystemContext((tx) =>
      ciContainerUsageRepository.markMeterReported(row.id, new Date(), tx),
    );
    return { outcome: 'reported', containerUsageId: row.id, idempotent: result.idempotent };
  },

  /**
   * Enqueue ONE charged storage day's report (MOTIR-7294). Called by the storage
   * charge pass after the day is recorded `charged`; best-effort like the container
   * enqueue, so it can never undo or fail the charge.
   */
  async enqueueStorageReport(storageChargeId: string): Promise<void> {
    if (!isCloudBilling()) return;
    await sendSystemEvent('system.platform-meter-report', { storageChargeId });
  },

  /**
   * The job's body for a storage day: one `kind: storage` report — the instance,
   * the day, a 10 GB volume's GB-seconds and the day's storage cost. Only a CHARGED
   * day is reported; every motir-ai failure throws so the job retries, and the
   * receiver is idempotent on `storage:<instance>:<day>`.
   */
  async reportStorage(storageChargeId: string): Promise<StorageReportOutcome> {
    const row = await withSystemContext((tx) =>
      agentInstanceStorageChargeRepository.findForMeterReport(storageChargeId, tx),
    );
    if (!row) return { outcome: 'missing' };
    if (row.chargeOutcome !== 'charged') return { outcome: 'not_charged' };

    const result = await reportPlatformMeter({
      kind: 'storage',
      instanceId: row.agentInstanceId,
      coreOrganizationId: row.organizationId,
      day: row.day.toISOString().slice(0, 10),
      gbSeconds: STORAGE_GB_SECONDS_PER_DAY,
      costUsd: STORAGE_COST_USD_PER_DAY,
    });
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceStorageChargeRepository.markMeterReported(row.id, new Date(), tx),
    );
    return { outcome: 'reported', storageChargeId: row.id, idempotent: result.idempotent };
  },

  /**
   * THE BACKFILL (MOTIR-7294): report every settled container and every charged
   * storage day the rollup has not accepted yet, so its history starts with the
   * meter's rather than on the day this shipped.
   *
   * Bounded: `batch` rows per read, walked in id order, each read fresh — never a
   * table load. Exactly once across runs: a row is stamped when the receiver
   * accepts it and the next run reads only unstamped rows. A row motir-ai refuses
   * or cannot take is counted `failed`, left unstamped, and the walk moves past it,
   * so one bad row never stalls the rest and the next run tries it again.
   */
  async backfill(opts: { batch?: number } = {}): Promise<MeterBackfillSummary> {
    const batch = opts.batch ?? METER_BACKFILL_BATCH;
    const summary: MeterBackfillSummary = {
      containers: { reported: 0, failed: 0 },
      storageDays: { reported: 0, failed: 0 },
    };

    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const rows: { id: string; containerProvider: string; handleId: string }[] =
        await withSystemContext((tx) =>
          ciContainerUsageRepository.listUnreportedSettled(cursor, batch, tx),
        );
      for (const row of rows) {
        try {
          await this.reportContainer(row.containerProvider, row.handleId);
          summary.containers.reported += 1;
        } catch {
          summary.containers.failed += 1;
        }
      }
      if (rows.length < batch) break;
      after = rows[rows.length - 1]!.id;
    }

    after = null;
    for (;;) {
      const cursor: string | null = after;
      const rows: { id: string; workspaceId: string }[] = await withSystemContext((tx) =>
        agentInstanceStorageChargeRepository.listUnreportedCharged(cursor, batch, tx),
      );
      for (const row of rows) {
        try {
          await this.reportStorage(row.id);
          summary.storageDays.reported += 1;
        } catch {
          summary.storageDays.failed += 1;
        }
      }
      if (rows.length < batch) break;
      after = rows[rows.length - 1]!.id;
    }
    return summary;
  },
};
