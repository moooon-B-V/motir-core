'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { List, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { PlanProposalList } from '@/components/planning/PlanProposalList';
import { Segmented } from '@/components/ui/Segmented';
import {
  PLAN_VIEW_PARAM,
  defaultPlanView,
  planViewFromParam,
  type PlanViewDto,
} from '@/lib/planning/planView';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { PlanReviewRail, type PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
  revisePlanRequest,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

// The plan-detail island (Subtask 7.4.5 / MOTIR-847) — the generation-review MODE
// of the canvas+chat workspace shell (MOTIR-1193). It composes the proposed-plan
// canvas (left) + the review rail (right), and OWNS: the "live while generating"
// poll of the substrate read (`getPlan`, re-fetched — NEVER the 7.4 stream), the
// Approve(materialize) / Decline actions, and the stale-warning confirm before an
// approve when items have drifted. Seeded from the server read; `router.refresh`
// can't reach a client island's `useState` seed, so state updates flow through
// this island's own refetch on every mutation + poll tick (the page-state rule).
//
// APPROVE is the page-state contract's "a mutation touching BOTH does BOTH" case
// (MOTIR-1947): it changes this island (the review → `approved`, via `refetch`)
// AND a surface rendered on the SERVER — the establish step, which the page reads
// only for an approved plan and hands down as `repositorySet`. A refetch cannot
// produce that prop and a refresh cannot reach this island's state, so approve
// does both. Decline and the proposal inline edit do NOT refresh: neither reveals
// a server-rendered surface, and surface kind 1 (the edited cell) must not.

const POLL_MS = 2500;

export interface PlanDetailProps {
  initialReview: PlanReviewDto;
  ariaLabel?: string;
  /**
   * The project's repository SET, when the plan is approved and the project has
   * one (Story MOTIR-1775 · MOTIR-1782). Present → the establish step takes a
   * BAND across the TOP of the canvas pane, at its own natural height, and the
   * canvas takes the remainder.
   *
   * ⚠️ THIS REPLACES, AND DOES NOT DELETE, THE RULE THAT STOOD HERE
   * (`design/ai-planning/design-notes.md` Part VI §4; bug MOTIR-3154). It read:
   * *"Present → the canvas pane holds the ESTABLISH STEP instead of the
   * proposals: once the plan has materialized, the canvas of proposals has served
   * its purpose, and replacing it is the truthful use of the space."*
   *
   * That is correct ON ITS OWN PREMISE, and Part VI overturns the premise rather
   * than the conclusion. The premise is that the pane holds PROPOSALS — and a
   * proposal genuinely is spent by the decision that resolves it, so replacing it
   * with the next task WAS the truthful use of the space. After MOTIR-3160 and
   * MOTIR-3161 the pane no longer holds proposals: it holds the RECORD of the
   * decision — the accepted cards, on their real level, on the work items they
   * became — and a record is PRODUCED by the decision rather than spent by it.
   *
   * The second reason they can share the pane at all is that they are different
   * KINDS. The establish step is a TASK — MOTIR-1782's own central claim is that
   * its default path is one sentence, one primary, one quiet secondary. The
   * canvas is a RECORD. A task and a record can share a pane vertically; only two
   * records compete for it. Nothing INSIDE the step changes: MOTIR-1782 keeps
   * every decision it made about what the step says.
   *
   * Null → nothing changes (an un-decided plan, a declined one, a project with no
   * set, or a repo-set read that failed — the step is an addition to this page,
   * never a precondition for it).
   */
  repositorySet?: { projectKey: string; view: ProjectRepoEstablishViewDto } | null;
  /** The plan's project — the canvas reads its per-level roadmap (MOTIR-3083). */
  projectKey: string;
}

export function PlanDetail({
  initialReview,
  ariaLabel,
  repositorySet,
  projectKey,
}: PlanDetailProps) {
  const t = useTranslations('planReview');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [review, setReview] = useState<PlanReviewDto>(initialReview);
  // The one line the rail's approved outcome carries about the project's code.
  // DERIVED from the server read so a page load is already correct, then taken
  // over by the step reporting its own outcome — the rail is a sibling client
  // component, so nothing here needs a server round-trip to say "your code is
  // ready".
  //
  // Derived rather than `useState`-seeded (MOTIR-1947): the seed of a client
  // island runs ONCE at mount, so the prop the approve refresh delivers would be
  // ignored and the rail would carry no code line in the very breath it starts
  // saying "Approved". Only the step's OWN report is state, and null there simply
  // means "the step has not spoken yet" — it never emits null itself.
  const [reportedCodeOutcome, setReportedCodeOutcome] = useState<PlanCodeOutcome | null>(null);
  const codeOutcome = reportedCodeOutcome ?? codeOutcomeOf(repositorySet?.view ?? null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // ── THE REVISION (Subtask MOTIR-3601) ────────────────────────────────────
  // The DRAFT and the local in-flight window live here rather than in the rail:
  // the island is what submits, and the rail is presentational, exactly as the
  // approve/decline handlers already are.
  const [reviseDraft, setReviseDraft] = useState('');
  const [revising, setRevising] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const planId = initialReview.id;

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      const fresh = await fetchPlanReview(planId, signal);
      setReview(fresh);
      setVersion((v) => v + 1);
      return fresh;
    },
    [planId],
  );

  // ⚠️ POLL WHILE A REVISION HOLDS THE PLAN, and re-run the SERVER read when it
  // lands (Part XII §F). The revision arrives from a JOB while the reviewer sits
  // on the page, so nothing on the client knows when it finished; the same
  // `getPlan` re-fetch the generating poll uses answers it, because the lease it
  // must observe is derived from the plan's own trail.
  //
  // `router.refresh()` on the LANDING is what updates the surfaces only the
  // server renders. It cannot reach this island's own `useState` seed — which is
  // exactly why `refetch` runs too, and why the two are not interchangeable.
  useEffect(() => {
    if (review.revision === null) return;
    const ctrl = new AbortController();
    const handle = setInterval(() => {
      void refetch(ctrl.signal)
        .then((fresh) => {
          if (fresh.revision === null) {
            setRevising(false);
            router.refresh();
          }
        })
        .catch(() => {
          /* best-effort poll — a transient failure just retries next tick */
        });
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(handle);
    };
  }, [review.revision, refetch, router]);

  // Live polling WHILE generating — the proposed items stream in per level as the
  // engine emits them. Stops the instant the plan leaves `generating`.
  useEffect(() => {
    if (review.status !== 'generating') return;
    const ctrl = new AbortController();
    const handle = setInterval(() => {
      void refetch(ctrl.signal).catch(() => {
        /* best-effort poll — a transient failure just retries next tick */
      });
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(handle);
    };
  }, [review.status, refetch]);

  const onRevise = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text) return;
      setRevising(true);
      setErrorCode(null);
      try {
        await revisePlanRequest(planId, text);
        // Clear the field only on a DISPATCHED revision: a submit that was
        // refused leaves the instruction where the reviewer can send it again.
        setReviseDraft('');
        // Read the lease back immediately rather than waiting a poll tick, so
        // the gate holds in the same breath the reviewer pressed Send.
        await refetch();
      } catch (err) {
        setRevising(false);
        setErrorCode(
          err instanceof PlanRequestError ? (err.code ?? 'REVISE_FAILED') : 'REVISE_FAILED',
        );
        // ⚠️ PUT THE INSTRUCTION BACK. The shipped composer clears its own draft
        // the moment it submits (`onSubmit(text); onDraftChange('')`), which is
        // right for a chat turn that always lands and wrong for a submit that can
        // be REFUSED — a reviewer whose revision was refused by a lease would
        // otherwise have to retype what they just asked for, at the exact moment
        // they are being told to try again.
        setReviseDraft(text);
        // A refusal is usually a fact about the plan (a lease, a frozen status),
        // so show the reader what the plan actually is beside the message.
        await refetch().catch(() => undefined);
      }
    },
    [planId, refetch],
  );

  const runAction = useCallback(
    async (
      action: (id: string) => Promise<unknown>,
      { refreshServerSurfaces = false }: { refreshServerSurfaces?: boolean } = {},
    ) => {
      setBusy(true);
      setErrorCode(null);
      try {
        await action(planId);
        await refetch();
        // The other half of the contract: re-run the page's SERVER read so a
        // surface only it can produce (the establish step) appears in this same
        // page view. Opt-in per action — a refresh nothing on the page needs is
        // a wasted round-trip, and on the wrong surface it is a bug.
        if (refreshServerSurfaces) router.refresh();
      } catch (err) {
        // A 409 is NOT an error on this surface (MOTIR-3240). It means the plan
        // moved between render and click — a concurrent reviewer decided it, or
        // the producer finished and it left `generating` — and the refetch below
        // shows the reader exactly that. The decision was still made, so a server
        // surface it reveals is just as due as on our own success.
        //
        // ⚠️ This used to set `errorCode` FIRST and then refetch, so the rail
        // rendered "that didn't work" above a plan whose real state was right
        // there beside it. That was wrong for the approve path too, and it is
        // corrected for both rather than special-cased for the discard — the two
        // are the same event and there is no reading on which one of them is a
        // failure and the other is not.
        if (err instanceof PlanRequestError && err.status === 409) {
          await refetch().catch(() => {});
          if (refreshServerSurfaces) router.refresh();
        } else {
          setErrorCode(err instanceof PlanRequestError ? (err.code ?? 'ERROR') : 'ERROR');
        }
      } finally {
        setBusy(false);
        // Both confirms close on the way out, success or 409 alike: the action
        // has resolved and the refetch has already shown the plan's real state,
        // so leaving either dialog open would ask the reader to confirm a
        // decision that has already been made.
        setConfirmOpen(false);
        setDiscardOpen(false);
      }
    },
    [planId, refetch, router],
  );

  // Approving REVEALS the establish step, which only the server can render — so
  // this is the one action that also refreshes (MOTIR-1947).
  const approve = useCallback(
    () => runAction(approvePlanRequest, { refreshServerSurfaces: true }),
    [runAction],
  );

  const onApprove = useCallback(() => {
    if (review.stale) {
      setConfirmOpen(true);
      return;
    }
    void approve();
  }, [review.stale, approve]);

  // DECLINE, and its one confirming arm (MOTIR-3240). Ending a plan that is still
  // being written is irreversible from this surface and the plan is still moving,
  // so it confirms — the same shape the stale-approve confirm already uses, and
  // for the sharper reason. A `planned` plan has been read and declining it is
  // the ordinary decision; that path is unchanged.
  const onDecline = useCallback(() => {
    if (review.status === 'generating') {
      setDiscardOpen(true);
      return;
    }
    void runAction(declinePlanRequest);
  }, [review.status, runAction]);

  const discard = useCallback(() => void runAction(declinePlanRequest), [runAction]);

  // ⚠️ THE TERMINAL-EMPTY HAND-OFF IS GONE FROM THIS SURFACE (MOTIR-4124), and
  // what replaced it is the RAIL. A `return` before the workspace was mounted
  // took `PlanReviewRail` with it, so the one plan a reviewer could do nothing
  // about — zero proposals — was also the one plan they were given no Approve
  // and no Decline for. The Plans list offered none either (its row is a bare
  // link), so an empty plan sitting in the queue could not be ended from the UI
  // at all, and one undecided plan pauses that project's auto-plan cadence.
  //
  // The narrow fix — exclude the two AWAITING-DECISION statuses — would have
  // left a branch nothing can reach: `generating` was already excluded, decided
  // plans were already excluded, and `planned` / `stale` are the rest of the
  // vocabulary. So the branch goes, rather than being kept as a guard that can
  // never fire. A plan with no items now renders exactly as the design of
  // record draws a decided one with none (`design/ai-planning/design-notes.md`
  // Part VIII): the pane holds the roadmap's own empty state, and the rail
  // states the outcome or offers the decision.
  //
  // WHERE THE HAND-OFF LIVES INSTEAD — it was never only here. A generation
  // that produces nothing settles `usePlanGeneration`'s own `empty` phase, and
  // `GenerationFlow` draws that terminal with the same copy plus a Retry, on
  // the surface the person is actually standing on. This surface is reached by
  // opening a plan from the list, where "describe what you want to build" is
  // not what a reader came for.
  //
  // MOTIR-833 / MOTIR-1377 / MOTIR-3161 / MOTIR-3578 are what this replaces:
  // MOTIR-1377 stopped the empty state shadowing a DECLINED plan's outcome, and
  // MOTIR-3578 kept `stale` out of `decided` for the same reason. Both were
  // narrowing a branch whose real defect was that it could suppress the rail.
  //
  // ⚠️ THE `decided` BOOLEAN THAT STOOD HERE IS GONE (MOTIR-4495). It survived
  // one consumer past its usefulness: `PlanProposalList` swapped BOTH its
  // vocabularies on it, so a DECLINED plan's list rendered the APPROVED past
  // tense — `Created` / `Applied` / `Archived` about work that never happened,
  // the `add` row contradicting itself inside one line. Both bodies now read the
  // three-valued `outcome` eleven lines below, which is the value the canvas has
  // taken since MOTIR-3161 and the reason the canvas never had this bug.
  // The plan's decision, drawn on every node the plan contributes (MOTIR-3161).
  // WHICH BODY the pane shows. THE URL IS THE SINGLE SOURCE OF TRUTH (MOTIR-3239),
  // derived on every render exactly as `ChildPanel` derives `?children=` — so a
  // deep link, a reload and browser Back/forward all agree, and no local state
  // can disagree with the address bar.
  //
  // ⚠️ THE DEFAULT IS PINNED AT MOUNT (MOTIR-3262). It is DERIVED from the plan's
  // shape — the list when the proposals straddle more than one container — and a
  // `generating` plan's item set grows under the 2.5s poll below, so a plan can
  // cross that threshold while a reviewer is reading it. The default is a SEED
  // for the arriving reader, not a controlled value: recomputing it per render
  // would yank somebody between views on a poll tick. `useState`'s initializer
  // runs once, which is exactly the semantics wanted here.
  const [pinnedDefaultView] = useState<PlanViewDto>(() => defaultPlanView(initialReview));
  const view: PlanViewDto = planViewFromParam(searchParams.get(PLAN_VIEW_PARAM), pinnedDefaultView);

  const onViewChange = useCallback(
    (next: PlanViewDto) => {
      const params = new URLSearchParams(searchParams.toString());
      // THE DEFAULT WRITES A CLEAN URL, whatever the default is — so every
      // existing `/plans/[id]` link stays byte-identical, and the property
      // survives MOTIR-3262 making the default conditional.
      if (next === pinnedDefaultView) params.delete(PLAN_VIEW_PARAM);
      else params.set(PLAN_VIEW_PARAM, next);
      const query = params.toString();
      // SHALLOW (MOTIR-3434). BOTH bodies render from the `review` this island
      // already holds in `useState`, so the server has nothing to say — and
      // `router.push` here re-ran `/plans/[id]/page.tsx`'s seven awaits to
      // render what was already in the browser. That round trip is the
      // "clicking canvas or list doesn't go there immediately" this story was
      // reported for. `shallowPush` writes the same URL without it, keeps the
      // history entry so Back restores the previous view, and does not scroll —
      // which is what the old `scroll: false` was asking for (a body must never
      // yank the reader to the top of a pane they were already reading).
      shallowPush(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, pinnedDefaultView, searchParams],
  );

  const outcome: PlanItemOutcome | null =
    review.status === 'approved' ? 'accepted' : review.status === 'declined' ? 'declined' : null;
  return (
    <>
      <PlanningWorkspace
        className="h-full w-full"
        canvas={
          // BOTH, STACKED (Part VI §4). The step takes a band at the top at its
          // own natural height; the canvas takes the remainder with `min-h-0` so
          // it SHRINKS rather than pushing the band out, and is never replaced.
          // Once the step settles it collapses to its own one-line form and the
          // canvas has effectively the whole pane — no extra rule needed, because
          // the step's own design already shrinks.
          <div className="flex h-full min-h-0 w-full flex-col">
            {/* The PANE HEADER (Part VIII §2). The pane had none —
                `PlanningWorkspace`'s `canvas` slot is filled edge to edge — so
                one is decided here rather than found. It sits at the TOP of the
                pane, ABOVE the establish band, because the bar governs the BODY
                and the band is not part of the body: Part VI decided the step
                STACKS above the canvas, and a switcher under the band would make
                the band read as chrome belonging to one of the two views.
                (Part VIII reserved this bar's right end for Part IX's
                Show-changes control; Part IX RELEASED it and put that control in
                the canvas's own cluster, so the bar holds the switcher alone.) */}
            <div className="flex h-11 shrink-0 items-center border-b border-(--el-border) bg-(--el-surface) px-(--spacing-control-x)">
              <Segmented<PlanViewDto>
                label={t('viewSwitchAria')}
                value={view}
                onChange={onViewChange}
                options={[
                  { value: 'list', label: t('viewList'), icon: <List className="size-3.5" /> },
                  {
                    value: 'canvas',
                    label: t('viewCanvas'),
                    icon: <Workflow className="size-3.5" />,
                  },
                ]}
              />
            </div>
            {repositorySet ? (
              <div
                data-testid="plan-detail-establish-band"
                className="shrink-0 border-b border-(--el-border) bg-(--el-surface)"
              >
                {/* ⚠️ `connectHref` is the MEMBER's own GitHub account (Story
                    MOTIR-4669 · MOTIR-4682). Both places it is used ask the
                    reader to connect THEIR identity — the "connect your own" CTA
                    and a row's `not invited` action — and an identity is the one
                    git fact that is not the organisation's to grant. It pointed
                    at `/settings/workspace/github`, a route MOTIR-4680 deleted. */}
                <RepositorySetStep
                  projectKey={repositorySet.projectKey}
                  initialView={repositorySet.view}
                  backlogHref="/items"
                  connectHref="/settings/account/git"
                  onOutcomeChange={setReportedCodeOutcome}
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              {/* A SECOND BODY in the same pane, never a re-drawing of the first.
                  The canvas answers where a proposal LANDS; the list answers what
                  exactly is being approved, which is a question about a SET. */}
              {view === 'list' ? (
                <PlanProposalList items={review.items} outcome={outcome} />
              ) : (
                <PlanReviewCanvas
                  items={review.items}
                  projectKey={projectKey}
                  version={version}
                  outcome={outcome}
                  ariaLabel={ariaLabel ?? t('canvasAria')}
                />
              )}
            </div>
          </div>
        }
        chat={
          <PlanReviewRail
            review={review}
            onApprove={onApprove}
            onDecline={onDecline}
            busy={busy}
            errorCode={errorCode}
            codeOutcome={codeOutcome}
            onRevise={onRevise}
            reviseDraft={reviseDraft}
            onReviseDraftChange={setReviseDraft}
            revising={revising}
          />
        }
      />

      <Modal
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('discardConfirmTitle')}
        // The confirm NAMES the proposals already appended: the count is the one
        // fact that tells the reader what they are throwing away, and the second
        // half is the reassurance the whole substrate rests on — nothing was ever
        // created, so nothing is lost from the tree.
        description={t('discardConfirmBody', { n: review.itemCount })}
        size="sm"
      >
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDiscardOpen(false)} disabled={busy}>
            {t('discardConfirmCancel')}
          </Button>
          <Button variant="primary" onClick={() => void discard()} loading={busy} disabled={busy}>
            {t('discardConfirmCta')}
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('staleConfirmTitle')}
        description={t('staleConfirmBody', { n: review.staleCount })}
        size="sm"
      >
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
            {t('staleConfirmCancel')}
          </Button>
          <Button variant="primary" onClick={() => void approve()} loading={busy} disabled={busy}>
            {t('staleConfirmApprove')}
          </Button>
        </div>
      </Modal>
    </>
  );
}

/**
 * The one line the approved outcome gains about the project's code — `ready` once
 * every row of the set has SETTLED, `unfinished` while any is still unresolved
 * (proposed, creating or failed), and null when there is no set to speak of.
 *
 * "Settled" is the ADR §4.1 word: `created`, `connected` and `skipped` all count,
 * because a deliberately skipped row is a finished decision, not an unfinished
 * one — telling the user to "finish setting up repositories" they chose to go
 * without would be a nag about a choice they already made.
 */
function codeOutcomeOf(
  view: { set: { rows: { state: string; access: { state: string } }[] } } | null,
): PlanCodeOutcome | null {
  if (!view || view.set.rows.length === 0) return null;
  const settled = (state: string) =>
    state === 'created' || state === 'connected' || state === 'skipped';
  if (!view.set.rows.every((r) => settled(r.state))) return 'unfinished';
  // Settled is not the same as REACHABLE (MOTIR-1900). A repository Motir created
  // lives in Motir's org and is private, so a `created` row nobody has been
  // invited to is code the user cannot clone — the rail says so rather than
  // claiming it is ready. A `connected` row is the user's own repository and a
  // `skipped` row has none, so neither raises the question.
  const reachable = (row: { state: string; access: { state: string } }) =>
    row.state !== 'created' || row.access.state !== 'not_invited';
  return view.set.rows.every(reachable) ? 'ready' : 'needs_access';
}
