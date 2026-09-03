import { Prisma, type GithubInstallation, type GithubRepo } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { GitProviderId, NormalizedStatusEvent } from '@/lib/git/types';
import { changeRequestNoun } from '@/lib/git/labels';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { githubCiFeedbackCommentRepository } from '@/lib/repositories/githubCiFeedbackCommentRepository';
import { liveCheckRows } from '@/lib/github/checkSuites';
import type { ReportedCheckRun } from '@/lib/github/checkRuns';
import { reconcileRecordedCheckSet, shaSetClaimsComplete } from './checkSetReconcile';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { commentsService } from './commentsService';
import { workItemsService } from './workItemsService';
import { promoteDeliveredCardsOnGreen } from './ciPromotion';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';

// The provider-agnostic CI / pipeline → work-item feedback consumer (Story 7.10 ·
// MOTIR-894, generalized for GitLab in Story 7.23 · MOTIR-1477). This is THE ONE
// verification-feedback path: both the GitHub webhook (`githubWebhookService`,
// `check_suite`/`check_run`) and the GitLab webhook (`gitlabWebhookService`,
// `pipeline`) normalize their host's CI payload through the shared `GitProvider`
// seam and hand the resulting `NormalizedStatusEvent` here. Nothing below is
// host-specific — the two providers differ ONLY in how they resolve the connection
// + repo from their raw payload (GitHub keys on its App installation id; GitLab
// keys on the project id) and in the host URL a "view checks" link points at,
// which each provider supplies through the `resolveContext` callback. There is
// deliberately no second, divergent feedback path (the MOTIR-1475 rule that shaped
// `changeRequestStatusSync`).
//
// On a TERMINAL conclusion the consumer posts (or, on a later conclusion at the
// same head commit, UPDATES in place) THE feedback comment ON EVERY CARD THE
// CHANGE REQUEST DELIVERS, and flips each of their `ciState` verification
// signals — both per card since MOTIR-3770, both through the shipped services
// (`commentsService`, `workItemsService.setCiState`), never a raw write, under
// `withSystemContext` (a webhook has no active workspace).
//
// ⚠️ ONE COMMENT PER `(changeRequest, headSha)` PER DELIVERED CARD — not per
// check (MOTIR-2946), and not one for the whole delivery (MOTIR-3770). The
// per-card coordinate is stored in `github_ci_feedback_comment`, one row per
// `(pull request, head commit, work item)`, and that is now the ONLY place the
// comment's identity lives: MOTIR-3863 took the superseded
// `github_check_run.feedback_comment_id` mirror out of the generated client and
// MOTIR-3803 dropped the column, so this file neither reads nor writes it
// (`docs/decisions/ci-feedback-comment-per-card.md`,
// `docs/decisions/delivery-reader-migration.md` §6a). The rest of this note
// is about the `(changeRequest, headSha)` half, which is unchanged. The
// INGESTION key is `(pr, headSha, checkName, checkSuiteId)`: one `githubCheckRun`
// row per check PER RUN, which is what the Development surface derives "Checks
// running" and the `ciState` pill from, and what makes a redelivery of an
// already-recorded conclusion a no-op. The COMMENT key is one level coarser, and that is the whole
// point of the card: keyed per check, a motir-core PR (~34 checks) put ~34
// comments on one work item, each asserting "this work is verified" on the
// authority of a single check that has no view of the whole — so a run in flight
// could carry a red verdict and a green verdict about the same commit, minutes
// apart. The comment now carries the AGGREGATE over every check row at the head
// sha, is UPDATED in place as conclusions land, and reads as INTERIM while any
// check is still pending — a verdict is asserted only once the set is terminal.
//
// A pending conclusion is RECORDED as a row (so the Development surface can derive
// "Checks running", MOTIR-1579) with NONE of the terminal side-effects; a neutral
// conclusion, a check for a change request we don't track, or one with no linked
// work item are all clean no-ops.
//
// ⚠️ AND THE VERDICT READS ONLY THE RUNS THAT HAVE NOT BEEN REPLACED
// (MOTIR-3209). Two workflow runs at one head commit is ordinary —
// `cancel-in-progress` (MOTIR-3106) makes a label added after `gh pr create`
// cancel the run in flight — and the cancelled one's rows must decide nothing:
// its matrix legs are named `Vitest (${{ matrix.shard }}/…)` because GitHub had
// not expanded them yet, and `cancelled` maps to `failure`. `liveCheckRows`
// retires them, and the `neutral`-records-nothing rule below needs no exception
// for the mirror case (`Deploy to Fly`: cancelled in the loser, skipped in the
// winner) because the loser is no longer consulted at all. BOTH derivations
// share that one function — the comment's and the promotion's — since two
// opinions about one commit is exactly what MOTIR-2946 removed.

/** The CI-feedback result — the canonical outcome shared by both providers. The
 *  `event: 'ci'` tag is for logging / test assertions, not a wire contract. */
export type CiFeedbackResult = {
  event: 'ci';
  outcome:
    | 'verified' // a terminal SUCCESS → passing note + ciState 'passing'
    | 'failed' // a terminal FAILURE → failure summary + ciState 'failing'
    | 'noop' // a redelivery of an already-recorded conclusion
    | 'pending_recorded' // an in-flight check RECORDED as a pending row (MOTIR-1579) — no comment, no ciState
    | 'ignored_pending' // a neutral (skipped / stale) conclusion — a clean no-op
    | 'no_pull_request' // no stored change request matches the event's PR/MR list / branch
    | 'no_work_item' // the change request carries no linked work item — a clean no-op
    | 'unknown_installation'
    | 'unknown_repo'
    | 'malformed';
  workItemId?: string;
  ciState?: 'passing' | 'failing' | null;
  /** The work items a terminal GREEN promoted out of `implemented` (MOTIR-3006).
   *  Present only when it promoted at least one — a delivery that promotes N
   *  cards has to say N, for the same reason the merge close-out does. */
  promoted?: string[];
};

/** The connection + repo a provider hands the shared consumer, once it has
 *  resolved them from its own payload shape, plus the host-specific "view checks"
 *  URL builder (given the resolved change-request number). GitHub links to the
 *  PR's checks tab; GitLab to the MR's pipelines tab. */
export interface CiFeedbackContext {
  installation: GithubInstallation;
  repo: GithubRepo;
  buildChecksUrl: (changeRequestNumber: number) => string;
  /**
   * Ask the HOST which check runs a commit actually has (MOTIR-4199) — the one
   * thing this consumer cannot derive, because every derivation it makes is a
   * fold over the rows that have been RECORDED and nothing in that path knows
   * how many rows there will be.
   *
   * Optional, and its absence is a real answer: a provider that supplies none
   * keeps the pre-MOTIR-4199 behaviour, which is to trust the recorded set. It
   * returns `null` when the set could not be established (unreachable host,
   * refused permission, an unparseable answer) — NOT the same as an empty array,
   * which says the commit genuinely has no checks. `lib/services/checkSetReconcile.ts`
   * carries the whole contract.
   */
  readReportedCheckSet?: (commitSha: string) => Promise<ReportedCheckRun[] | null>;
}

/** What a provider's `resolveContext` returns: the resolved context, or a typed
 *  "couldn't resolve" reason the consumer surfaces as a clean no-op outcome. */
export type CiFeedbackContextResolution =
  | ({ kind: 'resolved' } & CiFeedbackContext)
  | { kind: 'unknown_installation' }
  | { kind: 'unknown_repo' };

/**
 * Apply one normalized CI / pipeline event to its linked work item's verification
 * feedback. `resolveContext` runs INSIDE the resolve transaction and maps the
 * provider's raw payload to `{ installation, repo, buildChecksUrl }` (or a
 * "couldn't resolve" reason). The event's change request (a GitHub PR / GitLab MR)
 * is resolved from the shared change-request table by the event's PR/MR-number
 * list first, else the head branch — the same resolver both hosts share.
 */
export async function applyCiStatusFeedback(
  event: NormalizedStatusEvent,
  resolveContext: (tx: Prisma.TransactionClient) => Promise<CiFeedbackContextResolution>,
): Promise<CiFeedbackResult> {
  // `neutral` (skipped / stale / manual) carries no signal at all — a logged no-op,
  // BEFORE any resolution (nothing to record for it either).
  if (event.conclusion === 'neutral') {
    return { event: 'ci', outcome: 'ignored_pending' };
  }

  // The CI run this check belongs to, as the row stores it: `''` is "no run
  // identity" — a legacy commit-`status` event, or any provider that reports
  // none — and NOT null, because Postgres treats NULLs in a unique index as
  // distinct and the upsert would stop converging (MOTIR-3209).
  const suiteId = event.suiteId ?? '';

  // Phase 1 — resolve under system context (one tx, no writes): connection + repo
  // (via the provider's resolver) → change request (by PR/MR-number list, else head
  // branch) → linked work item, the prior check row (for idempotency), and the
  // actor (workspace OWNER — a CI event carries no author, so the feedback is
  // attributed to the owner, the same fallback the status sync uses).
  const resolved = await withSystemContext(async (tx) => {
    const ctx = await resolveContext(tx);
    if (ctx.kind === 'unknown_installation') return { kind: 'unknown_installation' as const };
    if (ctx.kind === 'unknown_repo') return { kind: 'unknown_repo' as const };
    const { installation, repo, buildChecksUrl } = ctx;

    // ⚠️ BIND THE TENANT NOW (MOTIR-2880). `resolveContext` reached the CONNECTION
    // tier, which is what the system flag arms; the `work_item` and
    // `workspace_membership` reads below have no such arm, so before this call they
    // returned NULL under `motir_app` and every CI event resolved to
    // `no_work_item` — no feedback comment, no verification state, nothing raised.
    // Additive: `github_check_run` keeps its system arm for the write that follows.
    await bindWorkspaceContext(tx, repo.workspaceId);

    const cr = await resolveChangeRequest(repo.id, event, tx);
    if (!cr) return { kind: 'no_pull_request' as const };

    // ⚠️ A CHANGE REQUEST WITH NO LINKED CARD IS NOT NECESSARILY A NO-OP
    // (MOTIR-3006). A session pull request carries N cards and its head ref
    // deliberately names none of them, so it resolves through the SESSION arm
    // while the delivery is about real work. The rows must still be recorded and
    // the promotion still evaluated; what the session arm costs is the COMMENT
    // and the `ciState` flip, both of which need cards of their own to hang on.
    //
    // ⚠️ ONE MEMBERSHIP RULE (MOTIR-3721). This used to ask two questions of two
    // sources — the link column for "the" card, `findBySessionBranch` for the run
    // — which is the same shape the shared resolver exists to prevent the two
    // consumers of drifting apart on. It now asks the resolver, so the CI half
    // and the merge half cannot disagree about what a pull request delivers.
    const delivery = await resolveChangeRequestWorkItemSet({
      workspaceId: repo.workspaceId,
      headRef: cr.headRef,
      githubPullRequestId: cr.id,
      tx,
    });
    if (delivery.items.length === 0) return { kind: 'no_work_item' as const };
    // The cards this verdict is ABOUT, per card. Empty on the session arm, whose
    // cards are reached by the promotion below and by nothing else here — exactly
    // as a null link column reached nothing before.
    const deliveredWorkItemIds =
      delivery.kind === 'linked' ? delivery.items.map((item) => item.id) : [];

    const existing = await githubCheckRunRepository.findByKey(
      cr.id,
      event.commitSha,
      event.context,
      suiteId,
      tx,
    );
    // WHICH delivered cards already carry this commit's feedback comment
    // (MOTIR-3770) — read here because the idempotency guard below needs it, and
    // that guard used to answer the question off the legacy scalar, which names
    // ONE card however many the delivery reached.
    const commentedWorkItemIds = (
      await githubCiFeedbackCommentRepository.listByPrAndSha(cr.id, event.commitSha, tx)
    ).map((row) => row.workItemId);
    // `repo.workspaceId`, never `installation.workspaceId` (MOTIR-1931) — the repo
    // row carries the tenancy; the installation only supplies the provider
    // discriminator that picks the right noun for the feedback comment.
    const owner = await workspaceMembershipRepository.findOwnerByWorkspace(repo.workspaceId, tx);
    return {
      kind: 'resolved' as const,
      workspaceId: repo.workspaceId,
      provider: installation.provider as GitProviderId,
      /** EVERY card the pull request's delivery links name (MOTIR-3721) — empty
       *  for a session pull request, whose cards the promotion reaches instead. */
      deliveredWorkItemIds,
      /** The subset of them that already has a comment at this head commit. */
      commentedWorkItemIds,
      prId: cr.id,
      checksUrl: buildChecksUrl(cr.number),
      /** The prior row for THIS check, for the idempotency guard below. Its
       *  conclusion and nothing else: the legacy `feedback_comment_id` scalar
       *  left the generated client with MOTIR-3863, and the comment's identity
       *  is `github_ci_feedback_comment`'s. */
      existing: existing ? { conclusion: existing.conclusion } : null,
      readReportedCheckSet: ctx.readReportedCheckSet,
      actorUserId: owner?.userId ?? null,
    };
  });

  if (resolved.kind === 'unknown_installation')
    return { event: 'ci', outcome: 'unknown_installation' };
  if (resolved.kind === 'unknown_repo') return { event: 'ci', outcome: 'unknown_repo' };
  if (resolved.kind === 'no_pull_request') return { event: 'ci', outcome: 'no_pull_request' };
  if (resolved.kind === 'no_work_item') return { event: 'ci', outcome: 'no_work_item' };

  // The FIRST delivered card. It is no longer "the card the comment lands on" —
  // the comment reaches EVERY delivered card since MOTIR-3770 — and since
  // MOTIR-3863 / MOTIR-3803 there is no legacy
  // `github_check_run.feedback_comment_id` column to mirror it into. It is now ONE thing: the
  // card this result REPORTS in its scalar `workItemId` field, which callers and
  // tests read.
  const [firstDelivered] = resolved.deliveredWorkItemIds;

  // An in-flight check: RECORD the row (conclusion 'pending') so the per-change-request
  // "Checks running" state is derivable (MOTIR-1579), but with NONE of the terminal
  // side-effects — no feedback comment, no `WorkItem.ciState` flip (both stay
  // terminal-only, the MOTIR-894 contract). Nothing about the comment is written
  // here: its identity lives in `github_ci_feedback_comment`, keyed per
  // `(change request, head commit, card)`, and a pending conclusion reaches no
  // card.
  if (event.conclusion === 'pending') {
    await withSystemContext(async (tx) => {
      await githubCheckRunRepository.upsert(
        {
          pullRequestId: resolved.prId,
          commitSha: event.commitSha,
          checkName: event.context,
          checkSuiteId: suiteId,
          conclusion: 'pending',
        },
        tx,
      );
    });
    return {
      event: 'ci',
      outcome: 'pending_recorded',
      ...(reportedWorkItemId(resolved.deliveredWorkItemIds) ?? {}),
    };
  }

  if (!resolved.actorUserId)
    // No workspace owner to author the feedback comment — nothing to attribute.
    return {
      event: 'ci',
      outcome: 'no_work_item',
      ...(reportedWorkItemId(resolved.deliveredWorkItemIds) ?? {}),
    };

  // Idempotent: a redelivery of the SAME conclusion we already recorded (and
  // commented) is a no-op — never a duplicate comment. The check set at this sha
  // is unchanged by a redelivery, so the aggregate the comment carries is too.
  //
  // ⚠️ *COMMENTED* MEANS EVERY DELIVERED CARD (MOTIR-3770). The scalar arm alone
  // answers "the FIRST card has a comment", which on a delivery of N cards is a
  // different question — and it is the one that let a redelivery skip a card
  // carrying no comment at all. The per-card set is what makes the guard say what
  // it has always claimed to say; for a single-card delivery the two agree, which
  // is why nothing about that case changes.
  //
  // ⚠️ THE NON-EMPTY TEST IS THE SCALAR ARM'S JOB, NOT A NEW CONDITION
  // (MOTIR-3863). `resolved.existing.feedbackCommentId` used to stand for "some
  // comment exists at all", and on the SESSION arm — where `deliveredWorkItemIds`
  // is empty and `every` is therefore vacuously TRUE — it was the only thing
  // stopping a redelivery reporting `noop`. A session pull request writes no
  // comment, so the column stayed null and the guard never fired for one. With the
  // column dropped outright (MOTIR-3803), that half has to be said out loud: an empty
  // delivery set has commented on nothing and can never be a commented redelivery.
  if (
    resolved.existing &&
    resolved.existing.conclusion === event.conclusion &&
    resolved.deliveredWorkItemIds.length > 0 &&
    resolved.deliveredWorkItemIds.every((id) => resolved.commentedWorkItemIds.includes(id))
  ) {
    return {
      event: 'ci',
      outcome: 'noop',
      ...(reportedWorkItemId(resolved.deliveredWorkItemIds) ?? {}),
      ciState: event.conclusion === 'success' ? 'passing' : 'failing',
    };
  }

  const actorCtx = { userId: resolved.actorUserId, workspaceId: resolved.workspaceId };
  const noun = changeRequestNoun(resolved.provider);

  // ── 1. RECORD THIS CHECK'S ROW, ON ITS OWN, BEFORE ANY RENDERING (MOTIR-4264) ──
  // This delivery's conclusion is the one thing it holds that nothing else can
  // reproduce: GitHub does not retry a failed webhook delivery and no job carries
  // this path, so a row not written here is a vote that is GONE. Every derivation
  // downstream — the comment's summary, `deriveCiState`, both promotion edges — is
  // a fold over the RECORDED rows, so a dropped `failure` does not read as "we do
  // not know", it reads as GREEN, and the next success writes "this work is
  // verified" over a red build.
  //
  // It used to be the first write INSIDE the locked render transaction below,
  // which made it the statement that died when that transaction expired — the
  // observed `P2028` at this file's old `:353`, 5379 ms into a 5000 ms budget, all
  // of it spent waiting for the lock. Recording it FIRST makes the render a side
  // effect of a durable write rather than a condition of it (the post-commit
  // side-effects-are-best-effort rule the promotion below already follows).
  //
  // ⚠️ IT ALSO RETURNS THE COMMIT'S RECORDED SET, which costs one indexed read in
  // a transaction that is already open and saves MOTIR-4199's claim check below
  // from projecting this delivery into a set read before it: the row is committed
  // here, so what comes back IS the set the render is about to fold.
  const recordedAtSha = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, resolved.workspaceId);
    await githubCheckRunRepository.upsert(
      {
        pullRequestId: resolved.prId,
        commitSha: event.commitSha,
        checkName: event.context,
        checkSuiteId: suiteId,
        conclusion: event.conclusion,
      },
      tx,
    );
    return githubCheckRunRepository.listByPrAndSha(resolved.prId, event.commitSha, tx);
  });

  // ── 1b. IS THAT SET THE WHOLE SET? (MOTIR-4199) ──────────────────────────
  // Everything below folds these rows into a sentence and an action —
  // `⏳ CI running — 3 of 5` versus `✅ all 3 checks succeeded … This work is
  // verified`, and In Review versus held at Implemented. Every one of those
  // derivations reads the RECORDED rows, and none of them knows how many rows the
  // commit will have: GitHub delivers check runs one webhook at a time, so a
  // recorded set that is a PREFIX of the real one is the ordinary state of a pull
  // request's first minutes. The observed instance wrote the verified sentence and
  // promoted the card on three of five checks with the whole test suite running.
  //
  // The round trip is paid ONLY when the set CLAIMS to be whole — no live pending
  // row at this commit. With one there, the comment is interim and the promotion
  // withholds already, so there is no claim to check: a pull request carrying ~34
  // checks pays once, not thirty-four times. `lib/services/checkSetReconcile.ts`
  // carries the contract, the cost and what a `null` answer means.
  if (resolved.readReportedCheckSet && shaSetClaimsComplete(recordedAtSha)) {
    const reported = await resolved.readReportedCheckSet(event.commitSha).catch(() => null);
    if (reported !== null) {
      await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, resolved.workspaceId);
        await reconcileRecordedCheckSet({
          pullRequestId: resolved.prId,
          commitSha: event.commitSha,
          reported,
          recorded: recordedAtSha,
          tx,
        });
      });
    }
  }

  // ── 2. RENDER THE FEEDBACK — the FOLD under the lock, the WRITES outside it ──
  // Best-effort by construction (see `renderFeedbackComments`): the row above is
  // committed, so a render that fails must not fail the delivery. On a failure the
  // verdict is still derived from the store, because `ciState` and the promotion
  // are about the recorded set and not about whether a comment got written.
  const ciState = await renderFeedbackComments({
    prId: resolved.prId,
    workspaceId: resolved.workspaceId,
    commitSha: event.commitSha,
    checksUrl: resolved.checksUrl,
    noun,
    deliveredWorkItemIds: resolved.deliveredWorkItemIds,
    actorCtx,
  }).catch(async (err: unknown) => {
    console.error('[changeRequestCiFeedback] feedback render failed; the row still stands', {
      changeRequestId: resolved.prId,
      commitSha: event.commitSha,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return deriveRecordedCiState(resolved.prId, resolved.workspaceId, event.commitSha);
  });

  // Flip the verification signal through the service (no raw work_item write) —
  // ONCE PER DELIVERED CARD (MOTIR-3721). `ciState` is a per-card signal and this
  // verdict is about all of them: a pull request delivering two cards leaves the
  // second one's pill reading whatever the previous run left, which is a wrong
  // answer rather than a missing one. Only the LINKED arm has cards to flip here:
  // a session pull request's are reached by the promotion below, which is what
  // that delivery is actually for.
  for (const workItemId of resolved.deliveredWorkItemIds) {
    await workItemsService.setCiState(workItemId, ciState, actorCtx);
  }

  // ── CI GREEN PROMOTES (MOTIR-3006) ──────────────────────────────────────
  // EDGE 1 of the latch: a terminal green moves every card this change request
  // DELIVERS out of `implemented`. Not "the linked card" — a session pull request
  // carries N of them and its link column names none, which is the same 1:1
  // defect MOTIR-3007 fixes one hop later, so both call the one resolver.
  //
  // Runs AFTER the comment and the `ciState` write have committed, and is
  // best-effort for the reason `notes.html` #39 states: a side effect after a
  // durable write may never fail it. A promotion that throws would turn a
  // recorded verdict into a delivery the host retries forever, and the retry
  // would re-post nothing and re-promote nothing — the state is already right.
  const promoted =
    ciState === 'passing'
      ? await promoteDeliveredCardsOnGreen({
          changeRequestId: resolved.prId,
          workspaceId: resolved.workspaceId,
          actorUserId: resolved.actorUserId,
        }).catch((err: unknown) => {
          console.error('[changeRequestCiFeedback] promotion failed; the verdict still stands', {
            changeRequestId: resolved.prId,
            error: err instanceof Error ? err.message : 'unknown',
          });
          return [] as string[];
        })
      : [];

  return {
    event: 'ci',
    // A delivery with no linked card still reports the no-work-item outcome it
    // always did — what changed is that it now RECORDS its rows and evaluates the
    // promotion on the way there, which is the only thing a session pull request
    // could ever have wanted from this path.
    outcome: firstDelivered
      ? event.conclusion === 'success'
        ? 'verified'
        : 'failed'
      : 'no_work_item',
    ...(firstDelivered ? { workItemId: firstDelivered, ciState } : {}),
    ...(promoted.length > 0 ? { promoted } : {}),
  };
}

/** What ONE delivery may do to the feedback comment before it gives up: render,
 *  and re-render at most twice more if the recorded check set MOVED while it was
 *  writing. See `renderFeedbackComments` for why a re-render can be owed at all. */
const MAX_RENDER_PASSES = 3;

interface RenderFeedbackArgs {
  prId: string;
  workspaceId: string;
  commitSha: string;
  checksUrl: string;
  noun: string;
  deliveredWorkItemIds: readonly string[];
  actorCtx: { userId: string; workspaceId: string };
}

/**
 * Render THE feedback comment for `(change request, head commit)` onto every
 * delivered card, and answer the head commit's aggregate `ciState`.
 *
 * ⚠️ THE LOCK IS HELD OVER THE FOLD AND NOTHING ELSE (MOTIR-4264). The body is
 * derived from every check row at this commit, so deciding what to write is a
 * read-derived write and owes the row lock — that part is MOTIR-2946's rule and
 * is unchanged. What changed is what happens INSIDE it: `commentsService` opens
 * its OWN transaction on its OWN connection, so calling it under the lock held
 * the change request across N comment round trips, and every other check
 * finishing at that commit queued behind them on the same `FOR UPDATE`. A
 * motir-core pull request carries ~34 checks that finish in bursts, so the k-th
 * delivery waited on k−1 holders and blew Prisma's 5 s budget with a 500. The
 * fold is now three indexed statements and the comment writes happen after it has
 * committed.
 *
 * ⚠️ AND THAT COSTS THE ORDERING THE LOCK USED TO BUY, WHICH IS WHY THIS CONVERGES
 * RATHER THAN WRITING ONCE. Two deliveries that fold in order can still write out
 * of order, and the loser's older body would be the one that stands — permanently,
 * if it was the last check to land. So after writing, a delivery RE-READS the
 * recorded set: unchanged ⇒ what it wrote is current and it stops; changed ⇒
 * somebody landed a row while it was writing, and it renders again from the newer
 * set. Every delivery therefore leaves the comment agreeing with the rows recorded
 * at the moment it finished, which is exactly the property the long lock had.
 */
async function renderFeedbackComments(
  args: RenderFeedbackArgs,
): Promise<'passing' | 'failing' | null> {
  const { prId, workspaceId, commitSha, checksUrl, noun, deliveredWorkItemIds, actorCtx } = args;
  let ciState: 'passing' | 'failing' | null = null;

  for (let pass = 0; pass < MAX_RENDER_PASSES; pass += 1) {
    // THE FOLD — under the change request's row lock, and DB-ONLY. Nothing in
    // this callback reaches another connection.
    const fold = await withSystemContext(async (tx) => {
      // The tenant is known (phase 1 resolved it): the lock reads
      // `github_pull_request` and the comment rows are a tenant table with no
      // system arm (MOTIR-2880).
      await bindWorkspaceContext(tx, workspaceId);
      await githubPullRequestRepository.lockById(prId, tx);

      // Every row at this commit — this delivery's own included, because it was
      // committed before the lock was taken — MINUS every run a later run has
      // replaced (MOTIR-3209). `liveCheckRows` stays the one place that decides
      // which rows still vote.
      const stored = await githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
      const rows = liveCheckRows(stored);

      // THE comments for this head commit, one per card that already has one
      // (MOTIR-3770). This is the source of truth; a new check joins the comment
      // its card already carries instead of opening a second one.
      const recordedComments = await githubCiFeedbackCommentRepository.listByPrAndSha(
        prId,
        commitSha,
        tx,
      );

      return {
        rows,
        fingerprint: checkSetFingerprint(stored),
        bodyMd: feedbackCommentBody(summarizeChecks(rows), checksUrl, noun),
        commentByWorkItem: new Map(
          recordedComments.map((row) => [row.workItemId, row.commentId] as const),
        ),
      };
    });

    ciState = deriveCiState(fold.rows.map((r) => r.conclusion));
    // (deriveCiState ignores non-terminal conclusions — pending rows at this sha,
    // recorded for the Development surface, never gate the verdict.)

    // ONE COMMENT PER DELIVERED CARD (MOTIR-3770), written with NO lock held. The
    // set is EMPTY on the session arm — a session pull request's cards are reached
    // by the promotion and by nothing here — so this loop runs zero times for one,
    // and once for an ordinary single-card pull request.
    for (const workItemId of deliveredWorkItemIds) {
      await writeCardComment({
        prId,
        workspaceId,
        commitSha,
        workItemId,
        bodyMd: fold.bodyMd,
        existingCommentId: fold.commentByWorkItem.get(workItemId) ?? null,
        actorCtx,
      });
    }

    // Nothing was written, so there is nothing to keep current.
    if (deliveredWorkItemIds.length === 0) return ciState;

    // DID THE SET MOVE WHILE WE WROTE? One indexed read, no lock: if it did not,
    // the body on every card is the current one and this delivery is done.
    const after = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
    });
    if (checkSetFingerprint(after) === fold.fingerprint) return ciState;
  }

  return ciState;
}

/** Put `bodyMd` on ONE card's feedback comment for this `(change request, head
 *  commit)` — editing the comment the card already carries, or opening the one it
 *  does not.
 *
 *  ⚠️ THE CREATE IS ARBITRATED BY THE UNIQUE INDEX, NOT BY THE LOCK (MOTIR-4264).
 *  Two deliveries that both folded before either wrote can both find no comment
 *  row for a card, and the lock no longer spans the create that would have
 *  serialized them. `github_ci_feedback_comment` is unique on
 *  `(pull_request_id, commit_sha, work_item_id)`, so the row — not the comment —
 *  decides: the delivery whose insert lands owns the card's comment, and the other
 *  one DELETES the comment it just posted and edits the winner's instead. The
 *  duplicate MOTIR-2946 removed is a comment that STAYS; this one exists for the
 *  length of one round trip and never survives the request that made it. */
async function writeCardComment(args: {
  prId: string;
  workspaceId: string;
  commitSha: string;
  workItemId: string;
  bodyMd: string;
  existingCommentId: string | null;
  actorCtx: { userId: string; workspaceId: string };
}): Promise<void> {
  const { prId, workspaceId, commitSha, workItemId, bodyMd, existingCommentId, actorCtx } = args;

  if (existingCommentId) {
    // An edit whose body is unchanged is a no-op in `commentsService` — no
    // "Edited" tag, no event — so a delivery that moves nothing stays silent.
    await commentsService.editComment(existingCommentId, { bodyMd }, actorCtx);
    return;
  }

  const created = await commentsService.addComment(workItemId, { bodyMd }, actorCtx);
  const winner = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    return githubCiFeedbackCommentRepository.claim(
      { pullRequestId: prId, commitSha, workItemId, commentId: created.id },
      tx,
    );
  });

  if (winner.commentId === created.id) return;

  // We lost the race. Take our comment back out — a person must never be left
  // holding two verdicts about one commit — and make sure the surviving one
  // carries the body we folded.
  await commentsService.deleteComment(created.id, actorCtx);
  await commentsService.editComment(winner.commentId, { bodyMd }, actorCtx);
}

/** The recorded check set at one commit, as a value two reads can be compared on:
 *  which rows exist and what each one concluded. A row ARRIVING, a conclusion
 *  CHANGING and a run being superseded all change it, which is exactly the set of
 *  events that makes an already-written comment stale. */
function checkSetFingerprint(rows: { id: string; conclusion: string }[]): string {
  return rows
    .map((row) => `${row.id}:${row.conclusion}`)
    .sort()
    .join('|');
}

/** The head commit's aggregate verdict read straight from the store — the answer
 *  when rendering the comment failed. The verdict is about the RECORDED rows, so
 *  it is knowable whether or not anybody managed to write a sentence about them. */
async function deriveRecordedCiState(
  prId: string,
  workspaceId: string,
  commitSha: string,
): Promise<'passing' | 'failing' | null> {
  const rows = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    return githubCheckRunRepository.listByPrAndSha(prId, commitSha, tx);
  });
  return deriveCiState(liveCheckRows(rows).map((r) => r.conclusion));
}

/** Resolve the stored change request (PR / MR) for a CI event — by the event's
 *  PR/MR-number list first (the strongest link), else the head branch (stable
 *  across a re-push). Null when neither resolves to a stored row.
 *
 *  ⚠️ NO `workItemId` IN THE PROJECTION (MOTIR-3721). It used to carry the link
 *  column, and that scalar was consumed at EIGHT sites below — the feedback
 *  comment and the `ciState` write among them — so an ordinary pull request's
 *  CI verdict reached exactly ONE card whatever its delivery set held. WHICH
 *  cards a change request delivers is `resolveChangeRequestWorkItemSet`'s one
 *  question, asked by the caller; this function's job is to find the ROW. */
async function resolveChangeRequest(
  repoId: string,
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; number: number; headRef: string } | null> {
  for (const number of event.prNumbers) {
    const pr = await githubPullRequestRepository.findByRepoAndNumber(repoId, number, tx);
    if (pr) return { id: pr.id, number: pr.number, headRef: pr.headRef };
  }
  if (event.headBranch) {
    const pr = await githubPullRequestRepository.findByRepoAndHeadRef(repoId, event.headBranch, tx);
    if (pr) return { id: pr.id, number: pr.number, headRef: pr.headRef };
  }
  return null;
}

/** The work item's aggregate CI signal from its TERMINAL check conclusions at one
 *  commit: any failure → 'failing'; else at least one success → 'passing'; else
 *  null. Non-terminal rows ('pending', recorded for the Development surface since
 *  MOTIR-1579) match neither predicate, so they never gate the verdict. */
function deriveCiState(conclusions: string[]): 'passing' | 'failing' | null {
  if (conclusions.some((c) => c === 'failure')) return 'failing';
  if (conclusions.some((c) => c === 'success')) return 'passing';
  return null;
}

/** The check set at one head commit, folded to what the ONE feedback comment says
 *  about it: how many checks there are, which ones FAILED (by name — the roll-up
 *  must lose nothing a per-check comment carried), and how many are still
 *  RUNNING, which is what makes the verdict interim rather than terminal. */
export interface CheckSetSummary {
  total: number;
  failed: string[];
  pending: number;
}

/** Fold the head commit's check rows into the summary the comment renders. */
export function summarizeChecks(
  rows: { checkName: string; conclusion: string }[],
): CheckSetSummary {
  return {
    total: rows.length,
    failed: rows.filter((r) => r.conclusion === 'failure').map((r) => r.checkName),
    pending: rows.filter((r) => r.conclusion === 'pending').length,
  };
}

/**
 * THE feedback comment's body for a change request at one head commit — the
 * aggregate over its whole check set, never one check's conclusion generalized to
 * "this work" (MOTIR-2946).
 *
 * Three readings, and the first is the one the per-check body could not express:
 * while ANY check is still running the comment reads as INTERIM and asserts no
 * verdict — a red-then-green pair of contradicting comments minutes apart is what
 * a system of record must not do. Once the set is terminal it says passing or
 * failing ONCE, naming every failed check so nothing a reader had before is lost.
 */
export function feedbackCommentBody(
  summary: CheckSetSummary,
  checksUrl: string,
  noun: string,
): string {
  const { total, failed, pending } = summary;
  const failedList = failed.map((name) => `\`${name}\``).join(', ');

  if (pending > 0) {
    const done = total - pending;
    const soFar = failed.length > 0 ? ` **${failed.length} failed so far:** ${failedList}.` : '';
    return `⏳ **CI running** — ${done} of ${total} ${plural(total, 'check')} complete on the linked ${noun} ([view checks](${checksUrl})).${soFar} No verdict yet.`;
  }

  if (failed.length > 0) {
    return `❌ **CI failed** — ${failed.length} of ${total} ${plural(total, 'check')} did not pass on the linked ${noun} ([view checks](${checksUrl})): ${failedList}. This work item is marked **not-ready**; it needs another pass.`;
  }

  return `✅ **CI passing** — all ${total} ${plural(total, 'check')} succeeded on the linked ${noun}. This work is verified.`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** The `workItemId` field a CI outcome reports — the FIRST delivered card, or
 *  nothing at all when the change request delivers none through its links.
 *
 *  A spread rather than a value so an outcome with no card omits the key entirely,
 *  which is the shape every one of these results has always had. A delivery
 *  carrying SEVERAL cards reports the first here and the full set through
 *  `promoted`; naming all of them in this field would change a scalar that
 *  callers and tests read (MOTIR-3721). */
function reportedWorkItemId(
  deliveredWorkItemIds: readonly string[],
): { workItemId: string } | null {
  const [first] = deliveredWorkItemIds;
  return first ? { workItemId: first } : null;
}
