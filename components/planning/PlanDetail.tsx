'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { PlanReviewRail, type PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
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

  // Terminal EMPTY — a plan with no proposed content (and not still generating):
  // hand off to the discovery chat to describe what to build (MOTIR-833).
  // A DECIDED plan (approved/declined) is NEVER empty, and the `!decided`
  // short-circuit stays — but its REASON has changed (MOTIR-3161). It was added
  // because `declinePlan` DROPPED every PlanItem, so a declined plan fell into
  // this empty state and SHADOWED the rail's declined outcome ("Plan declined —
  // your tree was left untouched") — MOTIR-1377. MOTIR-3160 retains the rows, so
  // a declined plan is no longer empty and the guard no longer covers for that.
  // It is kept because a decided plan's outcome must reach the rail regardless of
  // item count: a plan decided with genuinely zero proposals still has an outcome
  // to state, and the discovery hand-off is the wrong thing to say about it.
  const decided = review.status === 'approved' || review.status === 'declined';
  // The plan's decision, drawn on every node the plan contributes (MOTIR-3161).
  const outcome: PlanItemOutcome | null =
    review.status === 'approved' ? 'accepted' : review.status === 'declined' ? 'declined' : null;
  const isEmpty = review.items.length === 0 && review.status !== 'generating' && !decided;

  if (isEmpty) {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-12 w-12" aria-hidden />}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={
          <Link
            href="/direction"
            className="inline-flex items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) py-(--spacing-btn-y) text-sm font-semibold text-(--el-accent-text) hover:bg-(--el-accent-pressed)"
          >
            {t('emptyCta')}
          </Link>
        }
      />
    );
  }

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
            {repositorySet ? (
              <div
                data-testid="plan-detail-establish-band"
                className="shrink-0 border-b border-(--el-border) bg-(--el-surface)"
              >
                <RepositorySetStep
                  projectKey={repositorySet.projectKey}
                  initialView={repositorySet.view}
                  backlogHref="/items"
                  connectHref="/settings/workspace/github"
                  onOutcomeChange={setReportedCodeOutcome}
                />
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <PlanReviewCanvas
                items={review.items}
                projectKey={projectKey}
                version={version}
                outcome={outcome}
                ariaLabel={ariaLabel ?? t('canvasAria')}
              />
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
