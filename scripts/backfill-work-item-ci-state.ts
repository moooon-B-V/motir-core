/**
 * `pnpm db:backfill:ci-state` — recompute `WorkItem.ciState` for every card that
 * has pull requests, through the shipped recompute (MOTIR-5472).
 *
 * THE DEFECT. `WorkItem.ciState` had one writer, and it STAMPED the verdict of
 * whichever pull request's webhook was in hand onto every card that pull request
 * delivered (MOTIR-5470 replaces it with a fold over the card's whole delivery
 * set). Existing rows therefore carry three kinds of wrong answer: a stale
 * per-pull-request verdict on a card delivered by more than one; `null` on every
 * card a run delivered through its own session branch, which the old writer never
 * reached; and no `running` anywhere, because the pending arm wrote nothing.
 *
 * WHY A BACKFILL RATHER THAN WAITING FOR THE NEXT EVENT. For most of these cards
 * there is no next event. The checks have finished, so nothing further will
 * report; a card whose pull request merged last month will read its stale verdict
 * for ever. A badge and a filter are about to be built on this column, so each of
 * those rows is a card somebody looks for and does not find, or finds and does
 * not need.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE FOLD. Every card is handed to
 * `deliveryVerdict.recomputeWorkItemCiState` — the same function the live path
 * calls, under the same row lock. A backfill that folded the set in SQL would be
 * a second opinion about one card, and the two would drift on the first amendment
 * to either.
 *
 * IDEMPOTENT BY CONSTRUCTION: the recompute writes only when the value changed,
 * so a SECOND RUN OVER UNCHANGED DATA REPORTS `changed: 0` AND WRITES NOTHING.
 * That is a property of the recompute rather than of a shrinking candidate query,
 * which is what lets `--dry-run` predict a real run exactly — both fold the same
 * set through the same code, and only one of them writes. Each card commits in
 * its own transaction, so an interrupted run keeps its progress and the re-run
 * resumes from the rest.
 *
 * ARCHIVED CARDS ARE SKIPPED AND COUNTED. Archiving is a human saying this card
 * should not be worked; recomputing its badge is not this sweep's business, and
 * counting the skips keeps the abstention visible rather than inferable from a
 * smaller total.
 *
 * CROSS-TENANT BY DEFAULT — every workspace's rows have this gap.
 * `--workspace=<id>` narrows to one tenant.
 *
 * Usage:
 *   pnpm db:backfill:ci-state --dry-run              # rehearse: fold + print, write nothing
 *   pnpm db:backfill:ci-state                        # apply everywhere
 *   pnpm db:backfill:ci-state --workspace=<id>
 *
 * It runs against the LIVE tenant and needs only `DATABASE_URL` — unlike the
 * base-ref backfill it makes NO host calls, because every input it folds is
 * already recorded in the database:
 *
 *   DATABASE_URL='<neon non-pooling url>' pnpm db:backfill:ci-state --dry-run
 *
 * Do the dry run first, read the `from → to` counts, and only then apply.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { workItemCiStateBackfillService } from '@/lib/services/workItemCiStateBackfillService';
import type { CiStateBackfillReport } from '@/lib/services/workItemCiStateBackfillService';

const TAG = '[backfill-ci-state]';

interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let workspaceId: string | undefined;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--workspace=')) workspaceId = arg.slice('--workspace='.length);
    else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return { dryRun, workspaceId };
}

/** `null` prints as a word rather than as nothing — an empty cell in a
 *  `from → to` pair is unreadable, and "no checks" is a real verdict. */
function show(state: string | null): string {
  return state ?? 'none';
}

function printReport(report: CiStateBackfillReport): void {
  const { dryRun } = report;

  // The per-transition breakdown, which is what an operator reads to decide
  // whether the sweep did what they expected: `failing → passing` on a hundred
  // cards is a repair, and `passing → failing` on a hundred is a reason to stop.
  const byTransition = new Map<string, number>();
  for (const change of report.changed) {
    const key = `${show(change.from)} → ${show(change.to)}`;
    byTransition.set(key, (byTransition.get(key) ?? 0) + 1);
  }
  for (const [transition, count] of [...byTransition].sort((a, b) => b[1] - a[1])) {
    console.log(`${TAG}   ${dryRun ? 'would change' : 'changed'} ${count} card(s): ${transition}`);
  }

  for (const change of report.changed) {
    console.log(
      `${TAG}     ${change.identifier} (${change.workItemId}): ` +
        `${show(change.from)} → ${show(change.to)}`,
    );
  }

  for (const failure of report.failed) {
    console.error(`${TAG}   ${failure.workItemId} FAILED — ${failure.error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) console.log(`${TAG} DRY RUN — folding only, nothing will be written.`);
  console.log(
    `${TAG} scope: ${args.workspaceId ? `workspace ${args.workspaceId}` : 'every workspace'}.`,
  );

  const report = await workItemCiStateBackfillService.backfillCiState({
    dryRun: args.dryRun,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
  });
  printReport(report);

  console.log(
    `${TAG} done — ${report.scanned} card(s) with pull requests scanned, ` +
      `${report.changed.length} ${args.dryRun ? 'would change' : 'changed'}, ` +
      `${report.unchanged} already correct, ` +
      `${report.skippedArchived} archived (skipped), ` +
      `${report.failed.length} failed.` +
      (args.dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );

  // A failed card is a NON-ZERO exit even though the sweep completed: an operator
  // piping this into a check must not read "some cards still carry a wrong
  // verdict" as success.
  if (report.failed.length > 0) {
    console.error(`${TAG} ${report.failed.length} card(s) failed — see above.`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
