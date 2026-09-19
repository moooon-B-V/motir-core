/**
 * `pnpm db:converge:ejected-cards` — move each `manual` card the merge queue EJECTED
 * before the FOURTH AMENDMENT shipped onto the path a live ejection now takes: `in_review`
 * with ONE fresh awaiting approve-to-merge gate over the same commits (Story MOTIR-5799 ·
 * MOTIR-5809; `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 7).
 *
 * WHY. Until the re-ask shipped, a manual FAILURE ejection moved the card to
 * `implemented` and raised nothing: *Queue again* reused the old approval. That
 * shortcut is retired, so such a card would sit at `implemented` holding a decided gate
 * with no way back except a push — even when the failure was flaky and the code fine.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE MOVE OR THE RAISE. Each card goes through
 * `ejectedCardConvergenceService`, which calls `reaskMergeAfterEjection` — the entry
 * point a live ejection runs.
 *
 * THE POPULATION: a delivered member's latest exit is a FAILURE, not re-queued, at that
 * member's CURRENT head; the project is `manual`; the card is at `implemented`; its latest
 * merge gate is `approved`. Everything else is SKIPPED AND COUNTED by reason.
 *
 * IDEMPOTENT: a converged card is at `in_review`, so a second apply converges 0.
 *
 * Usage:
 *   pnpm db:converge:ejected-cards --dry-run    # rehearse: classify + print, write nothing
 *   pnpm db:converge:ejected-cards              # apply
 *
 *   DATABASE_URL='<neon non-pooling url>' pnpm db:converge:ejected-cards --dry-run
 *
 * Do the dry run first, read the counts, and only then apply. Running it on production
 * is its own task (MOTIR-5810), after the release that carries the re-ask is live.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { ejectedCardConvergenceService } from '@/lib/services/ejectedCardConvergenceService';
import type { ConvergeReport } from '@/lib/services/ejectedCardConvergenceService';

const TAG = '[converge-ejected-cards]';

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
      `skipped ${report.skipped.length} (head moved ${skippedBy('head_moved')}, ` +
      `auto mode ${skippedBy('auto_mode')}, already in_review ${skippedBy('already_in_review')}, ` +
      `no approved gate ${skippedBy('no_approved_gate')}, other status ${skippedBy('other_status')}, ` +
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
