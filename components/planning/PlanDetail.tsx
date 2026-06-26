'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanReviewCanvas } from '@/components/planning/PlanReviewCanvas';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import { ProposalEditModal } from '@/components/planning/ProposalEditModal';
import {
  approvePlanRequest,
  declinePlanRequest,
  fetchPlanReview,
  updateProposalRequest,
  PlanRequestError,
} from '@/lib/planning/planReviewClient';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { UpdateProposalInput } from '@/lib/dto/plans';

// The plan-detail island (Subtask 7.4.5 / MOTIR-847) — the generation-review MODE
// of the canvas+chat workspace shell (MOTIR-1193). It composes the proposed-plan
// canvas (left) + the review rail (right), and OWNS: the "live while generating"
// poll of the substrate read (`getPlan`, re-fetched — NEVER the 7.4 stream), the
// Approve(materialize) / Decline actions, and the stale-warning confirm before an
// approve when items have drifted. Seeded from the server read; `router.refresh`
// can't reach a client island's `useState` seed, so state updates flow through
// this island's own refetch on every mutation + poll tick (the page-state rule).

const POLL_MS = 2500;

export interface PlanDetailProps {
  initialReview: PlanReviewDto;
  ariaLabel?: string;
}

export function PlanDetail({ initialReview, ariaLabel }: PlanDetailProps) {
  const t = useTranslations('planReview');
  const [review, setReview] = useState<PlanReviewDto>(initialReview);
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
    async (action: (id: string) => Promise<unknown>) => {
      setBusy(true);
      setErrorCode(null);
      try {
        await action(planId);
        await refetch();
      } catch (err) {
        setErrorCode(err instanceof PlanRequestError ? (err.code ?? 'ERROR') : 'ERROR');
        // A 409 means a concurrent reviewer already decided — refetch to show it.
        if (err instanceof PlanRequestError && err.status === 409) await refetch().catch(() => {});
      } finally {
        setBusy(false);
        setConfirmOpen(false);
      }
    },
    [planId, refetch],
  );

  const onApprove = useCallback(() => {
    if (review.stale) {
      setConfirmOpen(true);
      return;
    }
    void runAction(approvePlanRequest);
  }, [review.stale, runAction]);

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
          <PlanReviewCanvas
            items={review.items}
            version={version}
            ariaLabel={ariaLabel ?? t('canvasAria')}
            // Editable only while planned — an approved/declined plan is immutable.
            onEditAdd={review.status === 'planned' ? onEditAdd : undefined}
          />
        }
        chat={
          <PlanReviewRail
            review={review}
            onApprove={onApprove}
            onDecline={onDecline}
            busy={busy}
            errorCode={errorCode}
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
          <Button
            variant="primary"
            onClick={() => void runAction(approvePlanRequest)}
            loading={busy}
            disabled={busy}
          >
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
