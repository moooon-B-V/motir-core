import { defineJob } from '../defineJob';
import type { PlatformMeterReportData } from '../types';

// The platform meter report (Story MOTIR-727 · MOTIR-5286, MOTIR-7294): one settled
// fleet container's — or one charged storage day's — usage and Motir cost, sent to
// motir-ai's platform usage rollup. `idempotent` because the receiver is: it keys
// on the container usage id / `storage:<instance>:<day>`, so a retry after a
// motir-ai outage adds nothing it already counted.
export const platformMeterReport = defineJob(
  { id: 'system.platform-meter-report', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const data = ctx.event.data as PlatformMeterReportData;
    if ('storageChargeId' in data) {
      const { storageChargeId } = data;
      return ctx.step.run('report-storage', () =>
        services.platformMeterReport.reportStorage(storageChargeId),
      );
    }
    const { containerProvider, handleId } = data;
    return ctx.step.run('report-container', () =>
      services.platformMeterReport.reportContainer(containerProvider, handleId),
    );
  },
);
