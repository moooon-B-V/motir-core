import { SystemPrincipalNotProvisionedError, resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { metaProjectKey } from '@/lib/ai/systemPrincipal';
import { jobDlqStandingFilingRepository } from '@/lib/repositories/jobDlqStandingFilingRepository';
import { jobRunDlqRepository, type StandingDlqDepth } from '@/lib/repositories/jobRunDlqRepository';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext } from '@/lib/workspaces/context';

// The DLQ STANDING-DEPTH filer (MOTIR-5869) — the implementation of
// `docs/decisions/dead-letter-standing-depth-filing.md` (MOTIR-5845). Read that
// record for the reasoning; this header states only what the code does.
//
// ── What it files, and what it must NEVER file ──────────────────────────────
// It turns a STANDING condition in `job_run_dlq` into an obligation:
// "<function>'s dead letters have stood undisposed for more than 7 days", whose
// remedy is to triage and dispose of the rows. It never files "job X is
// failing" — that is the EVENT path's sentence (`lib/jobs/engine/ledger.ts` →
// `lib/monitoring/jobFailureAlert.ts` → a bound monitor), it works, and this
// file does not touch it. The event path is blind to standing state; this is
// blind to nothing else. Neither watches itself: this sweep's own terminal
// failure is an EVENT, which the event path catches.
//
// ── The trigger — AGE, not count ────────────────────────────────────────────
// A function qualifies when its OLDEST unreplayed row last failed more than
// {@link DLQ_STANDING_AGE_DAYS} days ago. One broken deploy dead-lettered 670
// rows of one function, and that is one problem, not 670.
//
// ── Dedup and re-arm — the load-bearing half ────────────────────────────────
// One `job_dlq_standing_filing` row per function carries `armed`:
//   · armed and qualifying ⇒ file ONE bug, disarm;
//   · disarmed ⇒ file nothing for that function, whatever the depth does;
//   · the function's standing depth back at ZERO ⇒ re-arm.
// CLOSING THE BUG DOES NOT RE-ARM — the sweep never reads the bug at all. If it
// did, a backlog nobody drains would file a new card every sweep. And the sweep
// never CLOSES the bug either: disposal is a judgement (`replayDLQ` re-emits,
// and for `email.send` that is real mail), so a card that closed itself would
// assert a disposal nobody made.
//
// ── Who files, and where ────────────────────────────────────────────────────
// `job_run_dlq` is deployment-wide and has no binder, so it cannot file the way
// the monitor path does (as the connection's binder). It files as the Motir
// SYSTEM PRINCIPAL through `aiWorkItemsService.fileBug`, into the META project's
// own bug destination (`metaProjectKey()`, no parent ⇒ the project's product
// bug destination). A deployment with no system principal — a self-hosted
// build, which has no meta tenant — has nowhere to file, and the sweep says so
// in its result rather than failing every day (the `aiBugTelemetryService`
// precedent for a Motir-operated capability). The principal is resolved only
// when something is actually about to be filed, so an empty queue costs one
// grouped read.

/** How long a function's oldest unreplayed dead letter may stand before the
 *  sweep files. A constant, deliberately: no setting, no per-workspace override. */
export const DLQ_STANDING_AGE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The sweep's job id — named in the bug body so a reader can find the filer. */
export const DLQ_STANDING_DEPTH_SWEEP_ID = 'system.dlq-standing-depth-sweep';

/** What one sweep did — the job run's ledger output. */
export interface DlqStandingSweepSummary {
  /** Functions with at least one unreplayed dead letter. */
  standing: number;
  /** Of those, the functions past the age threshold. */
  qualifying: number;
  /** The keys of the bugs this sweep filed, one per function. */
  filed: string[];
  /** Qualifying functions already filed for and not yet re-armed. */
  alreadyFiled: number;
  /** Functions re-armed because their standing depth returned to zero. */
  rearmed: number;
  /** `no-system-principal` when there was something to file and no one to file it as. */
  skipped: 'no-system-principal' | null;
}

/** The filed bug's title. Never "failing" — that is the event path's sentence. */
export function dlqStandingBugTitle(functionId: string): string {
  return `Dead letters for \`${functionId}\` have stood undisposed for more than ${DLQ_STANDING_AGE_DAYS} days`;
}

/**
 * The filed bug's body: the function, the standing count and the oldest
 * `last_failed_at`, and a pointer at the DISPOSAL rule — never at a code fix.
 */
export function dlqStandingBugBody(
  depth: StandingDlqDepth,
  previousIdentifier: string | null,
): string {
  const rows =
    depth.standing === 1 ? '1 dead-lettered run' : `${depth.standing} dead-lettered runs`;
  const lines = [
    `\`${depth.functionId}\` has **${rows}** in \`job_run_dlq\` that nobody has replayed or ` +
      `discarded. The oldest last failed at **${depth.oldestLastFailedAt.toISOString()}**, more ` +
      `than ${DLQ_STANDING_AGE_DAYS} days ago.`,
    `**This is an undone chore, not a fault report.** Whether \`${depth.functionId}\` is failing ` +
      `*now* is the event path's question — a terminal failure alerts, and a bound monitor files ` +
      `it as its own bug. This card asks only that these rows be triaged and **disposed of**.`,
    `**To dispose of them:** follow *Disposing of a standing dead letter* under *Dead-letter ` +
      `queue* in \`docs/jobs.md\` — replay a row only when its failure was transient and the run ` +
      `is still wanted; otherwise export it and delete it.`,
    `**Nothing re-files while these rows stand, and closing this card does not re-arm it.** ` +
      `Only draining \`${depth.functionId}\`'s unreplayed rows to zero does. Close it once they ` +
      `are disposed of.`,
  ];
  if (previousIdentifier) {
    lines.push(
      `Filed again: the queue drained to zero after ${previousIdentifier} and has stood again since.`,
    );
  }
  lines.push(
    `Filed by \`${DLQ_STANDING_DEPTH_SWEEP_ID}\` — the decision is ` +
      `\`docs/decisions/dead-letter-standing-depth-filing.md\`.`,
  );
  return lines.join('\n\n');
}

const qualifies = (depth: StandingDlqDepth, now: Date) =>
  depth.oldestLastFailedAt.getTime() < now.getTime() - DLQ_STANDING_AGE_DAYS * DAY_MS;

type FileOutcome =
  | { outcome: 'filed'; identifier: string }
  /** Another sweep filed first — it held the lock while this one waited. */
  | { outcome: 'already-filed' }
  /** Drained (or aged below the threshold) since the sweep's first read. */
  | { outcome: 'no-longer-qualifying' };

export const dlqStandingDepthService = {
  /**
   * One sweep: re-arm what drained, then file ONE bug per qualifying, armed
   * function. One function's filing failing does not stop the others; the
   * failures are thrown together at the end so the job retries and, at the
   * last, alerts — and a retry cannot double-file, because a filed function
   * is disarmed.
   */
  async sweep(now: Date = new Date()): Promise<DlqStandingSweepSummary> {
    // Read the depth and re-arm in ONE transaction, so a function is re-armed
    // only on a reading of zero taken in the same snapshot.
    const { depths, rearmed, disarmed } = await withSystemContext(async (tx) => {
      const read = await jobRunDlqRepository.standingDepthByFunction(tx);
      const standingIds = new Set(read.map((d) => d.functionId));
      const before = await jobDlqStandingFilingRepository.listDisarmed(tx);
      const drained = before.filter((r) => !standingIds.has(r.functionId)).map((r) => r.functionId);
      const count = await jobDlqStandingFilingRepository.rearm(drained, now, tx);
      const stillDisarmed = new Set(
        before.filter((r) => standingIds.has(r.functionId)).map((r) => r.functionId),
      );
      return { depths: read, rearmed: count, disarmed: stillDisarmed };
    });

    const qualifying = depths.filter((d) => qualifies(d, now));
    const toFile = qualifying.filter((d) => !disarmed.has(d.functionId));
    const summary: DlqStandingSweepSummary = {
      standing: depths.length,
      qualifying: qualifying.length,
      filed: [],
      alreadyFiled: qualifying.length - toFile.length,
      rearmed,
      skipped: null,
    };
    if (toFile.length === 0) return summary;

    let principal: ServiceContext;
    try {
      principal = await resolveSystemPrincipal();
    } catch (err) {
      if (!(err instanceof SystemPrincipalNotProvisionedError)) throw err;
      return { ...summary, skipped: 'no-system-principal' };
    }

    const failures: string[] = [];
    for (const depth of toFile) {
      try {
        const result = await this.fileOne(depth.functionId, principal, now);
        if (result.outcome === 'filed') summary.filed.push(result.identifier);
        else if (result.outcome === 'already-filed') summary.alreadyFiled += 1;
      } catch (err) {
        failures.push(`${depth.functionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `The DLQ standing-depth sweep could not file for ${failures.length} function(s) ` +
          `(filed ${summary.filed.length}): ${failures.join('; ')}`,
      );
    }
    return summary;
  },

  /**
   * File for ONE function under its row lock — claim-and-lock, then decide from
   * the LOCKED row (the `monitorIngestionService.reconcileIssue` pattern).
   *
   * ⚠️ THE LOCK IS HELD ACROSS THE CREATE. `fileBug` owns its own transactions
   * and takes no `tx`, so this OUTER transaction holds the filing row while the
   * INNER one inserts the bug on disjoint rows. A concurrent sweep blocks on the
   * lock, then reads `armed = false` and files nothing.
   *
   * The depth is re-read under the lock: an operator who drained the queue
   * between the sweep's first read and this one is not filed about.
   *
   * ⚠️ THE ONE WINDOW THIS ACCEPTS is `reconcileIssue`'s: a crash after the bug
   * commits and before this transaction does leaves the row armed, and the next
   * sweep files a second bug. Closing it would need the create to join a
   * caller's transaction, which it deliberately does not.
   */
  async fileOne(functionId: string, principal: ServiceContext, now: Date): Promise<FileOutcome> {
    return withSystemContext(async (tx) => {
      await jobDlqStandingFilingRepository.insertIfAbsent(functionId, tx);
      const lockedId = await jobDlqStandingFilingRepository.lockByFunctionId(functionId, tx);
      const row = lockedId ? await jobDlqStandingFilingRepository.findById(lockedId, tx) : null;
      /* v8 ignore next 3 -- unreachable: the row was inserted (or already present)
         in THIS transaction, so the lock finds it. */
      if (!row) {
        throw new Error(
          `job_dlq_standing_filing row for ${functionId} vanished under its own lock`,
        );
      }
      if (!row.armed) return { outcome: 'already-filed' as const };

      const depth = await jobRunDlqRepository.standingDepthOfFunction(functionId, tx);
      if (!depth || !qualifies(depth, now)) return { outcome: 'no-longer-qualifying' as const };

      const bug = await aiWorkItemsService.fileBug(
        {
          projectKey: metaProjectKey(),
          title: dlqStandingBugTitle(functionId),
          descriptionMd: dlqStandingBugBody(depth, row.filedWorkItemIdentifier),
        },
        principal,
      );
      await jobDlqStandingFilingRepository.markFiled(row.id, bug.identifier, now, tx);
      return { outcome: 'filed' as const, identifier: bug.identifier };
    });
  },
};
