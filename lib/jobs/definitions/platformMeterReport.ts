import { defineJob } from '../defineJob';
import type { PlatformMeterReportData } from '../types';

// The platform meter report (Story MOTIR-727 · MOTIR-5286): one settled fleet
// container's seconds and Motir cost, sent to motir-ai's platform usage rollup.
// `idempotent` because the receiver is — it keys on the container usage id, so a
// retry after a motir-ai outage adds nothing it already counted.
export const platformMeterReport = defineJob(
  { id: 'system.platform-meter-report', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const { containerProvider, handleId } = ctx.event.data as PlatformMeterReportData;
    return ctx.step.run('report-container', () =>
      services.platformMeterReport.reportContainer(containerProvider, handleId),
    );
  },
);
