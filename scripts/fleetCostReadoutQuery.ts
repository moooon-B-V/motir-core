import { isCloudBilling } from '@/lib/billing/availability';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { renderMeterDisabled, renderReadout, type ReadoutInput } from './fleetCostReadout';

// THE FLEET COST READOUT, CALLABLE (Story MOTIR-4335 · MOTIR-4545).
//
// `fleet-cost-readout.ts` executes on import — it is a CLI — so nothing could call
// the readout as a function, and the story's end-to-end rehearsal has to run THE
// SHIPPED READOUT over the rows a container wrote rather than a second query
// written for the test. This is the runner's read-and-render step moved behind a
// function; the runner is now argument parsing, this call and a `console.log`.
//
// ⚠️ NO BEHAVIOUR CHANGED IN THE MOVE: the same two service reads, the same
// disabled-meter short circuit before any database read, the same renderer. It adds
// no arithmetic — see `fleetCostReadout.ts`'s header for why there is none.
// ⚠️ Internal COGS only. Nothing here is a charge.

export interface FleetCostReadout {
  /** What was rendered — `null` when the meter is disabled and nothing was read. */
  input: ReadoutInput | null;
  /** The text the operator sees. */
  text: string;
}

export async function buildFleetCostReadout(args: {
  organizationId?: string;
  /** An instant INSIDE the period to read — the service keys it itself. */
  at: Date;
}): Promise<FleetCostReadout> {
  // The disabled path STOPS before the database: off-cloud no fleet ever ran, and
  // reporting that emptiness as figures would state a fact the build cannot have.
  if (!isCloudBilling()) return { input: null, text: renderMeterDisabled() };

  const periodStart = periodStartFor(args.at);
  const metaSplit = await ciFleetCostMeterService.getMetaPeriodCostSplit(args.at);
  const org = args.organizationId
    ? {
        organizationId: args.organizationId,
        lines: await ciFleetCostMeterService.getOrgPeriodCostByWorkload(
          args.organizationId,
          args.at,
        ),
      }
    : undefined;

  const input: ReadoutInput = {
    periodStart,
    periodEnd: periodEndFor(periodStart),
    ...(org ? { org } : {}),
    metaSplit,
  };
  return { input, text: renderReadout(input) };
}
