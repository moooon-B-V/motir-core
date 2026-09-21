/**
 * `pnpm db:converge:unlanded-cards` — put every card the OLD rules left holding a spent
 * approval where the FOURTH AMENDMENT now puts it (Story MOTIR-5799 · MOTIR-5809;
 * `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 9).
 *
 * WHY. One approval authorizes ONE merge or enqueue action. Until that shipped, a card
 * whose merge did not land kept its approval and was offered a button that reused it.
 * Those buttons are gone, so a card left over from the old rules would sit with nothing
 * to press and nothing to say.
 *
 * THE FOUR POPULATIONS:
 *
 *   A. `implemented` with a standing RETRYABLE or SETTING exit at a member's head
 *      → `in_review` with ONE fresh approve-to-merge gate.
 *   B. `implemented` with a standing CONFLICT → already where the new rules put it:
 *      COUNTED and left alone.
 *   C. `approved` with a standing NEUTRAL removal → the removal spent the approval,
 *      so the card is asked again.
 *   D. `approved` holding an open member with no outcome at all, under an approval
 *      decided more than ten minutes ago → a host refusal nobody recorded (the record
 *      is newer than the press). One is written with the backfill-only code
 *      `unrecorded`, classed RETRYABLE, and the card is asked again.
 *
 * Everything else is SKIPPED AND COUNTED by reason.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE MOVE OR THE RAISE. Each card goes through
 * `ejectedCardConvergenceService`, which calls `settleUnlandedOutcome` — the entry point
 * a live queue exit and a live host refusal both run.
 *
 * IDEMPOTENT: a converged card is at `in_review`, so a second apply converges 0.
 *
 * Usage:
 *   pnpm db:converge:unlanded-cards --dry-run    # rehearse: classify + print, write nothing
 *   pnpm db:converge:unlanded-cards              # apply
 *
 *   DATABASE_URL='<neon non-pooling url>' pnpm db:converge:unlanded-cards --dry-run
 *
 * Do the dry run first, read the counts, and only then apply. Running it on production
 * is its own task (MOTIR-5810), after the release that carries the re-ask is live.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { ejectedCardConvergenceService } from '@/lib/services/ejectedCardConvergenceService';
import type { ConvergeReport } from '@/lib/services/ejectedCardConvergenceService';

const TAG = '[converge-unlanded-cards]';

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun };
}

function printReport(report: ConvergeReport): void {
  const verb = report.dryRun ? 'would converge' : 'converged';
  for (const card of report.converged) {
    console.log(`${TAG}   ${verb} ${card.identifier} (${card.workItemId}) → in_review + ONE gate`);
  }
  const byReason = new Map<string, string[]>();
  for (const skip of report.skipped) {
    byReason.set(skip.reason, [...(byReason.get(skip.reason) ?? []), skip.identifier]);
  }
  for (const [reason, keys] of byReason) {
    console.log(`${TAG}   skipped ${keys.length} — ${reason}: ${keys.join(', ')}`);
  }
  for (const failure of report.failed) {
    console.error(`${TAG}   ${failure.workItemId} FAILED — ${failure.error}`);
  }
  const skippedBy = (reason: string) => byReason.get(reason)?.length ?? 0;
  console.log(
    `${TAG} done — scanned ${report.scanned}, ${verb} ${report.converged.length}, ` +
      `skipped ${report.skipped.length} (conflict held ${skippedBy('cant_land_held')}, ` +
      `head moved ${skippedBy('head_moved')}, auto mode ${skippedBy('auto_mode')}, ` +
      `already in_review ${skippedBy('already_in_review')}, ` +
      `no approved gate ${skippedBy('no_approved_gate')}, nothing stranded ${skippedBy('nothing_stranded')}, ` +
      `too recent ${skippedBy('too_recent')}, other status ${skippedBy('other_status')}, ` +
      `archived ${skippedBy('archived')}), failed ${report.failed.length}.` +
      (report.dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) console.log(`${TAG} DRY RUN — classifying only, nothing will be written.`);
  const report = await ejectedCardConvergenceService.converge({ dryRun: args.dryRun });
  printReport(report);
  // A failed card is a NON-ZERO exit even though the sweep completed.
  if (report.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
