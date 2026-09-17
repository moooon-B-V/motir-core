import type { GithubCheckRun, Prisma } from '@/generated/prisma/client';
import { derivePrCiState, type PrCiState } from '@/lib/github/prCiState';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  deliveryStateForCard,
  foldCardCiState,
  repoCannotReportChecks,
} from '@/lib/workItems/deliverySet';

// A CARD'S DELIVERY SET, AND THE TWO VERDICTS READ OFF IT (MOTIR-5470).
//
// ── Why this is its own module ──────────────────────────────────────────────
// `ciPromotion` owns a QUESTION — may this card move out of `implemented`? — and
// it answered that question by collecting the card's deliveries and classifying
// each one. The card's stored `ciState` is a DIFFERENT question read off the very
// same set: not *may it move* but *what would a person see if they looked*.
//
// Two questions over one set is exactly the shape `everyDeliveryIsGreen`'s own
// header warns about one level down ("the latch only works if the two edges ask
// the same question of the same set"). So the SET and its per-member
// classification live here, once, and both consumers call it unmodified:
//
//   * the PROMOTION (`ciPromotion.everyDeliveryIsGreen`) maps each member through
//     `deliveryStateForPromotion` and asks `deliverySetIsGreen`;
//   * the CARD (`recomputeWorkItemCiState`, below) maps each member through
//     `deliveryStateForCard` and folds with `foldCardCiState`.
//
// The two mappers differ in ONE cell (a repository that can report and has not
// yet: `null` for the promotion, `'running'` for the card), which is what makes
// the column read `passing` exactly when the promotion would promote. If they
// read two different sets that equivalence would be a coincidence; reading one
// set makes it a property.

/**
 * EVERY pull request that delivers this card, by id, with the check rows the
 * verdict is derived from.
 *
 * ── The set is a UNION, and each arm exists for a shape the others cannot hold ─
 *   * `work_item_delivery` — the declared links, which is the ordinary case and
 *     the only one that is many-to-many;
 *   * the pull-request mirror's own `listByWorkItemWithContext` — rows written by
 *     `historicalPullRequestBackfillService`, which the delivery table has not
 *     been told about;
 *   * the card's `sessionBranch` — a `motir auto` run's pull request, which
 *     deliberately carries no card key at all and is therefore linked by nothing.
 *
 * ⚠️ THE THIRD ARM IS WHY A SESSION-BRANCH CARD FINALLY GETS A `ciState`. The
 * column's previous writer looped over the LINKED cards only, which is empty on
 * the session arm — so every card a run delivered through its own branch stayed
 * `null` for ever, however red its build. Reading the set here rather than
 * re-deriving it at the call site is what closes that, for both consumers at once.
 *
 * Deduplicated on the pull request's own id, so a row recorded on two arms counts
 * once. Extracted from `ciPromotion` (MOTIR-5470) rather than copied: a second
 * collection would be a second answer to *what delivers this card*, which is the
 * one thing this module exists to prevent.
 */
export async function collectDeliveries(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<Map<string, { repoId: string; checkRuns: GithubCheckRun[] }>> {
  const [deliveries, linked, onBranch] = await Promise.all([
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    githubPullRequestRepository.listByWorkItemWithContext(item.id, tx),
    item.sessionBranch
      ? githubPullRequestRepository.listByHeadRefWithChecks(item.sessionBranch, tx)
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, { repoId: string; checkRuns: GithubCheckRun[] }>();
  for (const delivery of deliveries) byId.set(delivery.githubPullRequestId, delivery.pullRequest);
  for (const pr of [...linked, ...onBranch]) byId.set(pr.id, pr);
  return byId;
}

/** One classified member of a card's delivery set: the verdict its own check rows
 *  give, plus whether its repository is able to report a check at all. */
export interface ClassifiedDelivery {
  repoId: string;
  /** `derivePrCiState` at this pull request's latest recorded sha. */
  state: PrCiState;
  /** True when a `null` state means "this repository has no CI" rather than
   *  "nothing has reported yet" (`repoCannotReportChecks`). */
  cannotReport: boolean;
}

/**
 * Classify every member of a card's delivery set — the shared read BOTH verdicts
 * are folded from.
 *
 * The per-member verdict is `derivePrCiState`, the SAME function the Development
 * pill shows, so a card's badge and its own pull-request pills can never disagree
 * about one pull request.
 *
 * ⚠️ THE SECOND QUESTION IS ASKED ONLY OF THE MEMBERS THAT NEED IT (MOTIR-3823).
 * `derivePrCiState` returns `null` both for a repository that has no CI and for
 * one that has simply not reported yet, and those must be read oppositely. The
 * follow-up is asked of the REPOSITORY, because the pull request cannot tell them
 * apart. A set with no `null` in it — nearly every card — pays nothing: the id
 * list is empty and both reads are skipped.
 */
export async function classifyDeliveries(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<ClassifiedDelivery[]> {
  const byId = await collectDeliveries(item, tx);

  const members = [...byId.values()].map((pr) => ({
    repoId: pr.repoId,
    state: derivePrCiState(pr.checkRuns),
  }));

  const silentRepoIds = [...new Set(members.filter((m) => m.state === null).map((m) => m.repoId))];
  const [reporting, mergedSilent] = await Promise.all([
    githubPullRequestRepository.listRepoIdsWithAnyCheckRun(silentRepoIds, tx),
    githubPullRequestRepository.listRepoIdsWithAWatchedMergeWithoutChecks(silentRepoIds, tx),
  ]);
  const hasReported = new Set(reporting);
  const hasMergedSilently = new Set(mergedSilent);
  // A repository neither read returns has no history at all, so it falls to
  // `hasEverReportedACheck: false, hasMergedWithoutAnyCheck: false` — which
  // `repoCannotReportChecks` reads as ABLE to report. Every unknown takes that
  // direction: for the promotion it withholds, and for the card it reads
  // `running`, which are the same conservative answer in two vocabularies.
  const cannotReport = new Set(
    silentRepoIds.filter((repoId) =>
      repoCannotReportChecks({
        repoId,
        hasEverReportedACheck: hasReported.has(repoId),
        hasMergedWithoutAnyCheck: hasMergedSilently.has(repoId),
      }),
    ),
  );

  return members.map((m) => ({
    repoId: m.repoId,
    state: m.state,
    cannotReport: cannotReport.has(m.repoId),
  }));
}

/**
 * RECOMPUTE one card's stored `ciState` from its whole delivery set, and write it
 * if it moved (MOTIR-5470).
 *
 * ── It is a RECOMPUTE, never a stamp, and that is the defect it closes ────────
 * The column's previous writer took the verdict of the pull request whose webhook
 * happened to be in hand and wrote it onto every card that pull request delivered.
 * Three consequences, all of them wrong in the direction that shows a person a
 * stale badge: a card with two pull requests read whichever reported LAST; a card
 * delivered through a run's session branch was never written at all; and a
 * pending check wrote nothing, so a card whose fix was already building kept
 * reading `failing`. Folding the set answers all three at once, because none of
 * them is a question about the event — they are questions about the card.
 *
 * ── THE LOCK IS HELD OVER THE FOLD, NOT ONLY OVER THE WRITE ──────────────────
 * This is a read-derived write: what gets stored is computed from rows another
 * transaction may be inserting concurrently (two workflows reporting at once is
 * the ordinary case, not the exotic one). Taking the card's row lock FIRST and
 * folding under it serializes the recomputes for one card, so the last one to
 * commit is the one that read the most rows. Locking only the write would let two
 * recomputes read the same pre-insert snapshot and race to store the same stale
 * answer — which looks identical to working, until the red one loses.
 *
 * `lockById` filters on the immutable `id` alone, so it cannot miss a row whose
 * status a racing transaction is changing underneath it.
 *
 * Runs INSIDE the caller's transaction and bound tenant context — `work_item` has
 * no system arm, so a caller must have bound a workspace before it gets here.
 * Returns the verdict it settled on, which is also what it stored.
 */
export async function recomputeWorkItemCiState(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<PrCiState> {
  // The lock comes before the read it guards, and the re-read after it: a value
  // read before the lock was granted is a value another transaction may already
  // have replaced.
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return null;

  const item = await workItemRepository.findById(workItemId, tx);
  if (!item) return null;

  const members = await classifyDeliveries({ id: item.id, sessionBranch: item.sessionBranch }, tx);
  const ciState = foldCardCiState(
    members.map((m) => deliveryStateForCard(m.state, m.cannotReport)),
  );

  // Idempotent: an unchanged verdict writes nothing. A check event that moves no
  // card is the common case — a second green on an already-green set — and a
  // no-op write would still burn a row version and an activity read.
  if (item.ciState !== ciState) {
    await workItemRepository.update(workItemId, { ciState }, tx);
  }
  return ciState;
}
