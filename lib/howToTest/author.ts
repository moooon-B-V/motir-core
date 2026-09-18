import { ERASED_USER_NAME } from '@/lib/users/accountErasure';
import type { HowToTestAuthorDto } from '@/lib/dto/howToTest';

// WHO wrote a HOW TO TEST record (Story MOTIR-5450 · Subtask MOTIR-5454).
//
// Pure, and its own module because TWO reads answer the same question and must
// answer it identically: the item page's block (`howToTestService`) and the v1
// fetch-by-key a CLI renders into a pull-request body
// (`testInstructionsService.getCurrentByIdentifier`). A second copy of this
// mapping is a second place for the two surfaces to disagree about an author.

/**
 * How a run is named in the block — the command a person would have typed and
 * when it started, e.g. `motir run · 2026-09-13 12:04 UTC`. A scoped run is
 * `motir run` too; that is what its operator typed.
 */
export function dispatchRunLabel(command: string, startedAt: Date): string {
  const typed = command === 'run_scope' ? 'run' : command;
  const when = startedAt.toISOString().slice(0, 16).replace('T', ' ');
  return `motir ${typed} · ${when} UTC`;
}

/** One record's attribution columns, as either read loads them. */
export interface TestInstructionsAuthorRow {
  dispatchRunId: string | null;
  dispatchRun: { command: string; startedAt: Date } | null;
  publishedById: string | null;
}

/**
 * WHO wrote a record — the TWO AUTHOR KINDS of `approval-gates.md` §9's
 * 2026-09-17 amendment, point 1.
 *
 * A record carrying a dispatch run is that run's; anything else is the PERSON
 * `published_by_id` names, which is exactly what `publish` writes when
 * `attributeToRunningDispatch` is false. The two arms are TOTAL because those
 * are the only two ways a row is written — there is one writer.
 *
 * ⚠️ The run arm needs the ROW and not just the id, and that costs nothing:
 * `dispatch_run_id` is `SetNull`, so a pruned run clears the id in the same
 * write that removes the row. An id with no row is unreachable rather than
 * merely unlikely.
 *
 * ⚠️ THE LABEL IS NEVER BLANK. A publisher whose account was deleted leaves
 * `published_by_id` null — `SetNull`, like every audit stamp on the row — and is
 * named by the product's standing string for a referent that is gone. That is
 * the same literal an ERASED profile carries in `user.name`
 * (`ERASED_USER_NAME`), so a deleted author and an erased one read identically
 * on the item page rather than in two phrasings for one fact. A present user
 * whose name is blank takes the same fallback, for the same reason: the line
 * reads *Written by …* and must name somebody.
 */
export function authorOf(
  row: TestInstructionsAuthorRow,
  nameById: ReadonlyMap<string, string>,
): HowToTestAuthorDto {
  if (row.dispatchRunId !== null && row.dispatchRun !== null) {
    return {
      kind: 'run',
      runId: row.dispatchRunId,
      label: dispatchRunLabel(row.dispatchRun.command, row.dispatchRun.startedAt),
    };
  }
  const userId = row.publishedById;
  const name = userId === null ? null : (nameById.get(userId)?.trim() ?? null);
  return { kind: 'person', userId, label: name && name.length > 0 ? name : ERASED_USER_NAME };
}
