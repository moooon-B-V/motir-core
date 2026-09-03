import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { GithubCheckRun, Prisma } from '@/generated/prisma/client';
import { derivePrCiState } from '@/lib/github/prCiState';
import {
  readReportedCheckSet,
  recordedSetClaimsComplete,
  reconcileRecordedCheckSet,
} from './checkSetReconcile';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import {
  deliverySetIsGreen,
  deliveryStateForPromotion,
  repoCannotReportChecks,
} from '@/lib/workItems/deliverySet';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from './workItemsService';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';
import {
  ContainerHasOpenChildrenError,
  IllegalTransitionError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// CI GREEN IS WHAT MAKES A CARD REVIEWABLE (MOTIR-3006).
//
// `implemented` says the code is pushed and the pull request is open; In Review
// says a human should look at it. The only thing entitled to move a card between
// those two is the build, and this module is where that happens — for EVERY card
// the pull request delivers, not for the one its link column happens to name.
//
// ── TWO EDGES, ONE VERDICT ──────────────────────────────────────────────────
// The run pushes BEFORE it transitions (MOTIR-3004 — `implemented` confirms the
// push rather than predicting it), so the green verdict can arrive first:
//
//   agent pushes → CI starts → CI goes GREEN → agent transitions to implemented
//                                   ↑                       ↑
//                        edge 1 fires and finds        edge 2 fires here
//                        nothing at `implemented`      and finds the green
//
// So the promotion is a LATCH, not an edge: it is evaluated both when CI reports
// and when a card ARRIVES at `implemented`, from the SAME durable verdict. The
// check rows are persisted, so edge 2 re-reads state that already exists rather
// than inventing a record or a queue.
//
// ⚠️ The window is NOT closed by widening the source states. Accepting
// `in_progress → in_review` on green would promote a card whose agent died
// before it finished, and would break the idempotence the `implemented` guard
// gives for free. The state stays `implemented`; what changes is WHEN the
// question gets asked.
//
// ── THE VERDICT IS `derivePrCiState`, DELIBERATELY ──────────────────────────
// Both edges ask the shipped per-PR derivation over ALL of a change request's
// rows, which computes at the LATEST recorded sha. That single choice buys three
// of this card's guards at once: a still-pending aggregate is `running` (not
// promoted), a failure is `failing` (not promoted), and a green run for a
// SUPERSEDED sha loses to the newer push's rows (not promoted). Re-deriving any
// of them here would be a second opinion that could drift from the pill a person
// reads on the Development surface.

/**
 * The refusals a promotion TOLERATES, per card.
 *
 * Each is a legitimate answer from a project's own workflow or permissions —
 * a custom workflow with no `in_review`, a missing edge to it, an actor without
 * edit rights there — and none of them says anything about the OTHER cards the
 * same run delivered. Anything not on this list is a real fault and is rethrown.
 */
const SKIPPABLE = [
  IllegalTransitionError,
  UnknownStatusError,
  ProjectAccessDeniedError,
  // The container-completeness gate (MOTIR-3229). A green build says nothing
  // about a card's own children, so a CONTAINER whose children are not landed is
  // refused In Review — and that refusal is precisely what the card is for: In
  // Review is a promise to a person, and MOTIR-1343 made it over two `todo`
  // children. Skippable rather than fatal for this list's stated reason: it says
  // nothing about the OTHER cards the same run delivered.
  ContainerHasOpenChildrenError,
];

/** The ONLY status a promotion moves a card out of. */
const SOURCE_STATUS = 'implemented';
/** The status CI green moves it to. */
const TARGET_STATUS = 'in_review';

/** Every pull request that delivers this card, by id, with the check rows the
 *  verdict is derived from — the union the doc block below explains, extracted
 *  (MOTIR-4199) so the check-set reconcile can address exactly the same members
 *  the judgement will. */
async function collectDeliveries(
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

/**
 * IS EVERY PULL REQUEST DELIVERING THIS CARD GREEN? (Story MOTIR-3655 ·
 * MOTIR-3685.)
 *
 * ── ONE function, called by BOTH edges ────────────────────────────────────
 * The latch only works if the two edges ask the same question of the same set.
 * Edge 1 fires because a pull request reported; edge 2 fires because a card
 * arrived at `implemented`. If one counted ANY and the other counted EVERY, a
 * card would be reviewable or not depending on which edge happened to run — and
 * nobody could tell which answer was the wrong one.
 *
 * ── The set is a UNION, deliberately, for the length of the EXPAND window ──
 * `work_item_delivery` holds rows the singular link column structurally cannot
 * (a `motir auto` pull request delivering twelve cards), and the column holds
 * rows the table has not been told about (`historicalPullRequestBackfillService`
 * resolves a card by parsing the title and writes only the column). Neither is
 * complete on its own today, and this is the ONE place where dropping a member
 * is dangerous in the direction that matters: a missed red pull request promotes
 * a card that is not reviewable. Deduplicated on the pull request's own id, so a
 * row recorded on both sides is counted once. The union collapses when
 * MOTIR-3672 retires the parse.
 *
 * The verdict per member is `derivePrCiState` — the SAME function the
 * Development pill shows and MOTIR-3697's `deliveries` field publishes, at the
 * latest recorded sha. A second opinion here would drift from what a person
 * reads on the card it is deciding about.
 *
 * ── ONE AMENDMENT, AND IT IS THE PROMOTION'S ALONE (MOTIR-3823) ───────────
 * `derivePrCiState`'s `null` means "no check rows", which is true of a
 * repository with NO CI and of one that has not reported YET. The first counts
 * as green and the second must withhold, so this function asks a second question
 * — of the REPOSITORY, since the pull request cannot tell them apart — and maps
 * the member through `deliveryStateForPromotion` before the set is judged. The
 * derivation itself is untouched: every surface that renders `null` as "no CI
 * pill" keeps doing so.
 */
async function everyDeliveryIsGreen(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const byId = await collectDeliveries(item, tx);

  const members = [...byId.values()].map((pr) => ({
    repoId: pr.repoId,
    state: derivePrCiState(pr.checkRuns),
  }));

  // ⚠️ THE SECOND QUESTION, ASKED ONLY OF THE MEMBERS THAT NEED IT (MOTIR-3823).
  // `derivePrCiState` returns `null` both for a repository that has no CI and for
  // one that has simply not reported yet, and the promotion must read those two
  // oppositely: the first is green, the second withholds. The follow-up is asked
  // of the REPOSITORY (`repoCannotReportChecks`), because the pull request cannot
  // tell them apart. A set with no `null` in it — nearly every card — pays
  // nothing: `silentRepoIds` is empty and the read is skipped entirely.
  const silentRepoIds = [...new Set(members.filter((m) => m.state === null).map((m) => m.repoId))];
  const [reporting, mergedSilent] = await Promise.all([
    githubPullRequestRepository.listRepoIdsWithAnyCheckRun(silentRepoIds, tx),
    githubPullRequestRepository.listRepoIdsWithAWatchedMergeWithoutChecks(silentRepoIds, tx),
  ]);
  const hasReported = new Set(reporting);
  const hasMergedSilently = new Set(mergedSilent);
  // A repository neither read returns has no history at all, so it falls to
  // `hasEverReportedACheck: false, hasMergedWithoutAnyCheck: false` — which
  // `repoCannotReportChecks` reads as ABLE to report, and which withholds. Every
  // unknown here takes that direction.
  const cannotReport = new Set(
    silentRepoIds.filter((repoId) =>
      repoCannotReportChecks({
        repoId,
        hasEverReportedACheck: hasReported.has(repoId),
        hasMergedWithoutAnyCheck: hasMergedSilently.has(repoId),
      }),
    ),
  );

  return deliverySetIsGreen(
    members.map((m) => deliveryStateForPromotion(m.state, cannotReport.has(m.repoId))),
  );
}

/**
 * EDGE 1 — CI has just reported a terminal verdict for one change request.
 *
 * Promotes every card that change request delivers and that currently sits at
 * `implemented`. Best-effort by construction: it runs AFTER the feedback
 * comment and the `ciState` write have committed, and a failure here must never
 * turn a recorded verdict into a webhook the host retries forever.
 *
 * Returns the ids it promoted, so a caller can report how many rather than
 * asserting one.
 */
export async function promoteDeliveredCardsOnGreen(args: {
  changeRequestId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<string[]> {
  const targets = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, args.workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(args.changeRequestId, tx);
    if (!pr) return [];
    if (derivePrCiState(pr.checkRuns) !== 'passing') return [];

    // ⚠️ THE PULL REQUEST, NOT A CARD READ OFF IT (MOTIR-3721). This used to
    // resolve the pull request's own link column and hand the resolver a single
    // `linked` ref, which
    // capped an explicitly-linked pull request at ONE promoted card whatever its
    // delivery set held — the cap lived in a `| null` parameter, not in a column,
    // which is why no grep of the link column ever found it (ADR §2).
    const set = await resolveChangeRequestWorkItemSet({
      workspaceId: args.workspaceId,
      headRef: pr.headRef,
      githubPullRequestId: pr.id,
      tx,
    });
    // Only the cards at `implemented`. A sibling a human moved back to In
    // Progress to rework must not be yanked forward by a green run.
    const atImplemented = set.items.filter((item) => item.status === SOURCE_STATUS);

    // ⚠️ AND ONLY THE ONES WHOSE WHOLE SET IS GREEN (MOTIR-3685). This pull
    // request going green is what WOKE the promotion; it is not what decides it.
    // A card this pull request delivers may also be delivered by another that is
    // red or still running, and announcing it reviewable on half its evidence is
    // the defect. Evaluated per card, because the answer genuinely differs
    // between two cards the same pull request delivers.
    const green: string[] = [];
    for (const item of atImplemented) {
      // `set.items` carries no `sessionBranch`, and the legacy branch join needs
      // it — so the row is re-read rather than guessed at.
      const row = await workItemRepository.findById(item.id, tx);
      if (row && (await everyDeliveryIsGreen(row, tx))) green.push(item.id);
    }
    return green;
  });

  return promoteEach(targets, { userId: args.actorUserId, workspaceId: args.workspaceId });
}

/**
 * EDGE 2 — a card has just ARRIVED at `implemented`.
 *
 * Re-reads the change request's already-recorded verdict and promotes
 * immediately when it is terminally green, which is the case the push-first
 * ordering opens. A clean no-op for a card with no change request, an untracked
 * one, or one with no check rows yet — which is the ordinary case for a human
 * moving a card to Implemented by hand.
 *
 * Returns whether it promoted, so the caller can log it; never throws.
 */
export async function promoteIfCiAlreadyGreen(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
  /** The host reader, injectable for the same reason `applyCiStatusFeedback`
   *  takes its `resolveContext`: this edge has no delivery behind it, so there
   *  is no payload to carry a provider seam in, and a test that cannot supply
   *  one cannot exercise the partial-set case at all. Defaults to the real
   *  read; production callers pass nothing. */
  readCheckSet: typeof readReportedCheckSet = readReportedCheckSet,
): Promise<boolean> {
  // ⚠️ THE OTHER DOOR INTO THE PARTIAL-SET DEFECT (MOTIR-4199). Edge 1 reaches
  // this module through the CI-feedback consumer, which has already reconciled
  // the commit's check set against the host before it forms a verdict. Edge 2
  // has no delivery behind it at all — it fires because a card ARRIVED at
  // `implemented`, which the run does moments after `gh pr create`, when the
  // recorded set is at its most partial. Left alone it would read three
  // successes as five and promote for exactly the reason edge 1 no longer does.
  //
  // So it asks the same question, of the same set, before it judges — and it is
  // paid for on the same terms: only the delivering pull requests whose recorded
  // set CLAIMS to be complete are asked about, so the ordinary card (one pull
  // request, checks still reporting pending rows) pays nothing.
  await reconcileClaimedCompleteDeliveries(workItemId, ctx, readCheckSet);

  const shouldPromote = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, ctx.workspaceId);
    const item = await workItemRepository.findById(workItemId, tx);
    // Re-read rather than trusting the caller: between the transition committing
    // and this running, the card may have moved again.
    if (!item || item.status !== SOURCE_STATUS) return false;

    // ⚠️ EVERY pull request delivering it, not ANY (MOTIR-3685) — and the SAME
    // function edge 1 asks, so the latch cannot answer two ways depending on
    // which edge happened to fire. This is what makes the LAST pull request's
    // green promote a card whose earlier ones went green hours ago.
    return everyDeliveryIsGreen(item, tx);
  });

  if (!shouldPromote) return false;
  const promoted = await promoteEach([workItemId], ctx);
  return promoted.length > 0;
}

/**
 * Bring the recorded check set of every pull request delivering this card in
 * line with the host's, for the members that claim to be complete (MOTIR-4199).
 *
 * ⚠️ THE NETWORK READ IS OUTSIDE THE TRANSACTION, deliberately and structurally:
 * it is three phases — read the members, ask the host, write what is missing —
 * rather than one, because a round trip inside `withSystemContext` would hold a
 * connection open on GitHub's latency for every card arriving at Implemented.
 *
 * Best-effort in the same sense the promotion itself is: this runs before a
 * verdict, and an unreachable host must cost the sharper answer rather than the
 * card. Anything that throws leaves the recorded set exactly as it was, which is
 * the behaviour that shipped before this pass existed.
 */
async function reconcileClaimedCompleteDeliveries(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
  readCheckSet: typeof readReportedCheckSet,
): Promise<void> {
  try {
    const candidates = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, ctx.workspaceId);
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item || item.status !== SOURCE_STATUS) return [];
      const byId = await collectDeliveries(item, tx);
      // Only the members whose own recorded set asserts it is whole. A member
      // with a live pending row is already `running` and already withholds, so
      // there is no claim to check.
      return [...byId.entries()]
        .filter(([, pr]) => recordedSetClaimsComplete(pr.checkRuns))
        .map(([id]) => id);
    });

    for (const pullRequestId of candidates) {
      const subject = await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, ctx.workspaceId);
        return githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx);
      });
      if (!subject) continue;
      // The sha the verdict is formed at — the newest recorded row's, which is
      // what `derivePrCiState` picks. A member with no rows at all never reaches
      // here (`recordedSetClaimsComplete` is false for an empty set).
      const commitSha = latestRecordedSha(subject.checkRuns);
      if (!commitSha) continue;

      const reported = await readCheckSet({
        installationId: subject.repo.installation.installationId,
        owner: subject.repo.owner,
        name: subject.repo.name,
        commitSha,
      });
      if (reported === null) continue;

      await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, ctx.workspaceId);
        const recorded = await githubCheckRunRepository.listByPrAndSha(
          pullRequestId,
          commitSha,
          tx,
        );
        await reconcileRecordedCheckSet({
          pullRequestId,
          commitSha,
          reported,
          recorded,
          tx,
        });
      });
    }
  } catch (err) {
    console.warn('[ciPromotion] could not reconcile the check set; judging what is recorded', {
      workItemId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** The commit `derivePrCiState` judges at — the newest-CREATED row's sha, by the
 *  same rule, so the reconcile fills in the window the verdict reads. */
function latestRecordedSha(checkRuns: GithubCheckRun[]): string | null {
  if (checkRuns.length === 0) return null;
  return checkRuns.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).commitSha;
}

/**
 * Move each card through the SHIPPED authority, one transaction each, and treat
 * a per-card refusal as a skip rather than a failure of the whole promotion.
 *
 * A custom workflow with no `in_review`, an item whose status moved underneath
 * us, or an actor without edit rights on one project must not stop the other
 * cards of the same run from being promoted — the same per-item tolerance
 * `completeSession` applies to a session close-out.
 */
async function promoteEach(
  workItemIds: string[],
  ctx: { userId: string; workspaceId: string },
): Promise<string[]> {
  const promoted: string[] = [];
  for (const id of workItemIds) {
    try {
      await workItemsService.updateStatus(id, TARGET_STATUS, ctx);
      promoted.push(id);
    } catch (err) {
      if (!SKIPPABLE.some((kind) => err instanceof kind)) throw err;
      console.warn('[ciPromotion] skipped a card CI green could not promote', {
        workItemId: id,
        // Every member of SKIPPABLE extends Error, which the `.some()` above
        // cannot tell the compiler.
        error: (err as Error).message,
      });
    }
  }
  return promoted;
}
