import { FleetDebitMismatchError } from '@/lib/ciFleet/debitMismatchErrors';
import { isFleetMismatch } from '@/lib/dto/platformFleetMonitor';
import { alertFleetDebitMismatch } from '@/lib/monitoring/fleetDebitMismatchAlert';
import { platformFleetMonitorService } from '@/lib/services/platformFleetMonitorService';

// THE FLEET DEBIT MONITOR (Story MOTIR-6905 · MOTIR-7318): every debit period,
// judge every organisation the fleet monitor would show and raise one Sentry
// alert per MISMATCHED (org, reason). The verdict is the fleet monitor's
// (`platformFleetMonitorService.judgeOrganization` → `classify`), called and
// never re-derived, so the alert and the page cannot disagree.
//
// ⚠️ IT WRITES NOTHING. The capture is its only effect, so there is no commit to
// order it after, and a re-delivered or overlapping run only adds an event to
// the same fingerprinted issue.

export interface FleetDebitMonitorResult {
  /** Organisations judged this run. */
  orgs: number;
  /** Of those, how many held at least one mismatch. */
  mismatched: number;
  /** Alerts raised — one per mismatched (org, reason). */
  alerted: number;
  /** Organisations whose judgement threw — logged, judged again next run. */
  failures: number;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const fleetDebitMonitorService = {
  /** One pass. Never throws for one organisation. */
  async run(now: Date): Promise<FleetDebitMonitorResult> {
    const orgIds = await platformFleetMonitorService.listOrganizationsToJudge(now);
    const result: FleetDebitMonitorResult = {
      orgs: orgIds.length,
      mismatched: 0,
      alerted: 0,
      failures: 0,
    };

    for (const organizationId of orgIds) {
      try {
        const reading = await platformFleetMonitorService.judgeOrganization(organizationId, now);
        const mismatches = reading.verdicts.filter(isFleetMismatch);
        if (mismatches.length > 0) result.mismatched += 1;
        for (const reason of mismatches) {
          alertFleetDebitMismatch(
            new FleetDebitMismatchError(organizationId, reading.name, reason),
          );
          result.alerted += 1;
        }
      } catch (err) {
        result.failures += 1;
        console.error('[fleetDebitMonitorService] could not judge an organization', {
          organizationId,
          detail: detailOf(err),
        });
      }
    }
    return result;
  },
};
