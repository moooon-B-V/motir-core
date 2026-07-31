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
import { PlanReviewRail, type PlanCodeOutcome } from '@/components/planning/PlanReviewRail';
import { ProposalEditModal } from '@/components/planning/ProposalEditModal';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
  updateProposalRequest,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { UpdateProposalInput } from '@/lib/dto/plans';
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
   * one (Story MOTIR-1775 · MOTIR-1782). Present → the canvas pane holds the
   * ESTABLISH STEP instead of the proposals: once the plan has materialized, the
   * canvas of proposals has served its purpose, and replacing it is the truthful
   * use of the space. The rail is untouched and still reads "Approved", which is
   * what lets the user see their plan is safe while they answer.
   *
   * Null → nothing changes (an un-decided plan, a declined one, a project with no
   * set, or a repo-set read that failed — the step is an addition to this page,
   * never a precondition for it).
   */
  repositorySet?: { projectKey: string; view: ProjectRepoEstablishViewDto } | null;
}

export function PlanDetail({ initialReview, ariaLabel, repositorySet }: PlanDetailProps) {
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
        setErrorCode(err instanceof PlanRequestError ? (err.code ?? 'ERROR') : 'ERROR');
        // A 409 means a concurrent reviewer already decided — refetch to show it.
        // The decision was still an approval, so the server surface it reveals is
        // just as due as on our own success.
        if (err instanceof PlanRequestError && err.status === 409) {
          await refetch().catch(() => {});
          if (refreshServerSurfaces) router.refresh();
        }
      } finally {
        setBusy(false);
        setConfirmOpen(false);
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

  const onDecline = useCallback(() => void runAction(declinePlanRequest), [runAction]);

  // Inline edit of a proposed `add` (Subtask 7.21.6 / MOTIR-1370). The edit
  // trigger on an `add` node opens the modal; save PATCHes the proposal and
  // refetches the review model (the same client-island refetch the actions use —
  // router.refresh can't reach this island's useState seed). Only offered while
  // `planned` (an approved/declined plan is immutable).
  const [editingItem, setEditingItem] = useState<PlanReviewItemDto | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErrorCode, setEditErrorCode] = useState<string | null>(null);

  const onEditAdd = useCallback(
    (planItemId: string) => {
      const found = review.items.find((i) => i.planItemId === planItemId) ?? null;
      setEditErrorCode(null);
      setEditingItem(found);
    },
    [review.items],
  );

  const onSubmitEdit = useCallback(
    async (planItemId: string, input: UpdateProposalInput) => {
      setEditBusy(true);
      setEditErrorCode(null);
      try {
        await updateProposalRequest(planId, planItemId, input);
        await refetch();
        setEditingItem(null);
      } catch (err) {
        setEditErrorCode(err instanceof PlanRequestError ? (err.code ?? 'ERROR') : 'ERROR');
        // A 409 means a concurrent reviewer decided the plan — it's no longer
        // editable; refetch to show the new state and close the now-stale form.
        if (err instanceof PlanRequestError && err.status === 409) {
          await refetch().catch(() => {});
          setEditingItem(null);
        }
      } finally {
        setEditBusy(false);
      }
    },
    [planId, refetch],
  );

  // Terminal EMPTY — a plan with no proposed content (and not still generating):
  // hand off to the discovery chat to describe what to build (MOTIR-833).
  // A DECIDED plan (approved/declined) is NEVER empty even with zero items:
  // `declinePlan` DROPS every PlanItem, so without the `!decided` short-circuit a
  // declined plan falls into this empty state and SHADOWS the review rail's
  // declined outcome ("Plan declined — your tree was left untouched") — MOTIR-1377.
  // A decided plan's outcome lives in `PlanReviewRail`'s `DecidedOutcome`, so it
  // must always flow to the rail regardless of item count.
  const decided = review.status === 'approved' || review.status === 'declined';
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
          repositorySet ? (
            <RepositorySetStep
              projectKey={repositorySet.projectKey}
              initialView={repositorySet.view}
              backlogHref="/items"
              connectHref="/settings/workspace/github"
              onOutcomeChange={setReportedCodeOutcome}
            />
          ) : (
            <PlanReviewCanvas
              items={review.items}
              version={version}
              ariaLabel={ariaLabel ?? t('canvasAria')}
              // Editable only while planned — an approved/declined plan is immutable.
              onEditAdd={review.status === 'planned' ? onEditAdd : undefined}
            />
          )
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

      <ProposalEditModal
        item={editingItem}
        onOpenChange={(open) => {
          if (!open) setEditingItem(null);
        }}
        onSubmit={onSubmitEdit}
        busy={editBusy}
        errorCode={editErrorCode}
      />
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
