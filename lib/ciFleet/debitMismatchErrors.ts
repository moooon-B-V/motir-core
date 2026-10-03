import type { FleetMismatchVerdict } from '@/lib/dto/platformFleetMonitor';

// The fleet debit monitor's alert (Story MOTIR-6905 · MOTIR-7318). CAPTURED to
// Sentry and never thrown out of the job: the pass must reach every other org,
// and a throw would end it at the first one worth telling a person about. The
// diagnosis is in the message (the `dailyHealthCheck.ts` convention), because
// the message is the whole of what the platform admin reads.

/** Each mismatch, in the words an operator reads. */
export const FLEET_MISMATCH_WORDS: Record<FleetMismatchVerdict, string> = {
  running_not_debited: 'running, not debited',
  debited_nothing_running: 'debited, nothing running',
  exhausted_still_running: 'out of credits, still running',
};

/** What each mismatch means, so the alert says what to look at. */
const FLEET_MISMATCH_DIAGNOSIS: Record<FleetMismatchVerdict, string> = {
  running_not_debited:
    'a CI job has run longer than the debit window with no live accrual reaching the org, ' +
    'or with a debit motir-ai has not confirmed',
  debited_nothing_running:
    'the live charge accrued minutes in the window while no CI container of the org was in flight',
  exhausted_still_running:
    'the org is out of minutes and credits and still holds containers older than one debit ' +
    'period, so the zero stop did not fire',
};

/** One organisation whose running and debited disagree, for one reason. */
export class FleetDebitMismatchError extends Error {
  constructor(
    readonly organizationId: string,
    readonly organizationName: string | null,
    readonly reason: FleetMismatchVerdict,
  ) {
    super(
      `Fleet debit mismatch for ${organizationName ?? 'an unnamed organization'} ` +
        `(${organizationId}): ${FLEET_MISMATCH_WORDS[reason]} — ${FLEET_MISMATCH_DIAGNOSIS[reason]}.`,
    );
    this.name = 'FleetDebitMismatchError';
  }
}
