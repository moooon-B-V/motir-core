'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { ExpansionNudgeReview } from './ExpansionNudgeReview';
import { submitExpandJob, PlanEditsClientError } from '@/lib/planning/planEditsClient';
import { approvePlanRequest, declinePlanRequest } from '@/lib/planning/planReviewClient';
import {
  planDecisionErrorCode,
  readPendingProposal,
  summarizePlanApproval,
} from '@/lib/planning/planReview';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { ExpansionNudge } from '@/lib/dto/ready';

// The `/ready` expansion nudge (7.11.7 · MOTIR-904) — the cadence-side entrance
// into planning: the ready set drains, the nudge offers to expand the nominated
// stub, and the run's proposals are reviewed and confirmed INLINE.
//
// ⚠️ It reviews the PLAN, not the job's `planDelta` (MOTIR-1747). Every plan-edit
// handler in motir-ai returns `planDelta: { operations: [] }` and writes its
// output as `PlanItem` proposals instead, so polling the job result for creates
// meant this banner could NEVER leave "expanding" — it proposed nothing, every
// time, while the proposals sat unread in the Plan. It now polls the run's Plan
// and confirms through `POST /api/plans/[id]/approve` → `materialize`: the same
// single write path the conversational rail and `/plans/[id]` use. The trigger is
// irrelevant to the engine — all planning is the same planning.
//
// Declining DECLINES the plan (rather than just hiding the banner), so a nudge
// the user waves away does not leave a `planned` Plan behind — which the
// auto-plan pause (MOTIR-1740) would read as a proposal awaiting review forever.

const STORAGE_KEY_PREFIX = 'motir_expansion_nudge_dismissed_';

/** How often the banner re-reads the run's Plan while the job works. */
const POLL_MS = 2000;

type Phase = 'idle' | 'submitting' | 'polling' | 'review' | 'approving' | 'done' | 'error';

export function ExpansionNudgeBanner() {
  const t = useTranslations('ready');
  const [nudge, setNudge] = useState<ExpansionNudge | null>(null);
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [planId, setPlanId] = useState<string | null>(null);
  const [review, setReview] = useState<PlanReviewDto | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [approveResult, setApproveResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismissKey = nudge ? `${STORAGE_KEY_PREFIX}${nudge.nominatedKey}_${nudge.readyCount}` : '';

  useEffect(() => {
    fetch('/api/ready/nudge', { headers: { Accept: 'application/json' } })
      .then((res) => res.json())
      .then((data) => {
        if (!mountedRef.current) return;
        if (data && (data as ExpansionNudge).nominatedKey) {
          const key = `${STORAGE_KEY_PREFIX}${(data as ExpansionNudge).nominatedKey}_${(data as ExpansionNudge).readyCount}`;
          const dismissed = sessionStorage.getItem(key);
          if (!dismissed) {
            setNudge(data as ExpansionNudge);
            setVisible(true);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleDismiss = useCallback(() => {
    if (dismissKey) {
      sessionStorage.setItem(dismissKey, '1');
    }
    setVisible(false);
  }, [dismissKey]);

  const handleExpand = useCallback(async (itemKey: string) => {
    setPhase('submitting');
    setErrorCode(null);
    try {
      const { planId: pid } = await submitExpandJob(itemKey);
      if (!mountedRef.current) return;
      // No plan to watch (a stubbed or pre-MOTIR-1743 response) — there is
      // nothing this banner could ever review, so say so instead of polling
      // forever.
      if (!pid) {
        setErrorCode('NO_PLAN');
        setPhase('error');
        return;
      }
      setPlanId(pid);
      setPhase('polling');

      // The run has no SSE here (the nudge is a banner, not the workspace), so
      // it POLLS the plan the same way the plan-detail island does while a plan
      // is still `generating` — until it is `planned` and carries proposals.
      pollRef.current = setInterval(async () => {
        try {
          const pending = await readPendingProposal(pid);
          if (!mountedRef.current || !pending) return;
          if (pollRef.current) clearInterval(pollRef.current);
          setReview(pending);
          setPhase('review');
        } catch {
          // A transient read failure just waits for the next tick.
        }
      }, POLL_MS);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof PlanEditsClientError) {
        setErrorCode(err.code ?? 'UNKNOWN');
      } else {
        setErrorCode('UNKNOWN');
      }
      setPhase('error');
    }
  }, []);

  const handleApprove = useCallback(async () => {
    if (!planId) return;
    setPhase('approving');
    try {
      const approved = summarizePlanApproval(await approvePlanRequest(planId));
      if (!mountedRef.current) return;
      setPlanId(null);
      setReview(null);
      setApproveResult(t('nudge.approved', { count: approved.created.length }));
      setPhase('done');
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorCode(planDecisionErrorCode(err));
      setPhase('error');
    }
  }, [planId, t]);

  /** Waving the proposal away DECIDES its plan — nothing is written to the tree,
   *  and no run is left pending. The banner closes either way: a decline that
   *  fails is the server's business, not something to hold the user on. */
  const handleDecline = useCallback(async () => {
    setVisible(false);
    if (!planId) return;
    const pending = planId;
    setPlanId(null);
    setReview(null);
    try {
      await declinePlanRequest(pending);
    } catch {
      /* the plan stays pending; the user can decide it from /plans */
    }
  }, [planId]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!nudge || !visible) return null;

  return (
    <Card className="bg-(--el-tint-lavender) border-(--el-border-soft)">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          <span className="text-sm text-(--el-text-strong)">
            {t('nudge.body', {
              count: nudge.readyCount,
              key: nudge.nominatedKey,
              title: nudge.nominatedTitle,
            })}
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 p-(--spacing-icon-btn) rounded-(--radius-control) text-(--el-text-muted) hover:text-(--el-text) hover:bg-(--el-surface-soft)"
          aria-label={t('nudge.dismissAria')}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {phase === 'review' && review ? (
        <ExpansionNudgeReview
          proposals={review.items}
          onApprove={handleApprove}
          onDecline={handleDecline}
          approving={false}
        />
      ) : phase === 'approving' ? (
        <ExpansionNudgeReview
          proposals={review?.items ?? []}
          onApprove={handleApprove}
          onDecline={handleDecline}
          approving
        />
      ) : phase === 'done' ? (
        <div className="mt-3 flex items-center gap-2">
          <Pill tone="neutral">{approveResult}</Pill>
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="text-sm text-(--el-link)"
          >
            {t('nudge.dismissLabel')}
          </button>
        </div>
      ) : phase === 'error' ? (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-sm text-(--el-danger-text)">
            {t('nudge.error', { code: errorCode ?? '' })}
          </span>
          <button type="button" onClick={handleDismiss} className="text-sm text-(--el-link)">
            {t('nudge.dismissLabel')}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
            onClick={() => handleExpand(nudge.nominatedKey)}
            disabled={phase !== 'idle'}
          >
            {phase === 'submitting' || phase === 'polling'
              ? t('nudge.expanding')
              : t('nudge.expandLabel')}
          </Button>
          {nudge.readyCount === 0 ? (
            <span className="text-xs text-(--el-text-muted)">{t('nudge.emptyHint')}</span>
          ) : null}
        </div>
      )}
    </Card>
  );
}
