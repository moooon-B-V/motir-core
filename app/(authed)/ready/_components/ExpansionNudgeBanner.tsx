'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { ExpansionNudgeReview } from './ExpansionNudgeReview';
import {
  approvePlanDelta,
  fetchJobResult,
  submitExpandJob,
  PlanEditsClientError,
} from '@/lib/planning/planEditsClient';
import type { ExpansionNudge } from '@/lib/dto/ready';

const STORAGE_KEY_PREFIX = 'motir_expansion_nudge_dismissed_';

type Phase = 'idle' | 'submitting' | 'polling' | 'review' | 'approving' | 'done' | 'error';

export function ExpansionNudgeBanner() {
  const t = useTranslations('ready');
  const [nudge, setNudge] = useState<ExpansionNudge | null>(null);
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [addedChildren, setAddedChildren] = useState<Array<{ title: string; kind: string }> | null>(
    null,
  );
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
      const { jobId: jid } = await submitExpandJob(itemKey);
      if (!mountedRef.current) return;
      setJobId(jid);
      setPhase('polling');

      pollRef.current = setInterval(async () => {
        try {
          const result = await fetchJobResult(jid);
          if (!mountedRef.current) return;
          if (result.status === 'done' && result.result?.planDelta?.added) {
            if (pollRef.current) clearInterval(pollRef.current);
            setAddedChildren(result.result.planDelta.added);
            setPhase('review');
          } else if (result.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setErrorCode('JOB_FAILED');
            setPhase('error');
          }
        } catch {
          // polling will retry
        }
      }, 2000);
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
    if (!jobId) return;
    setPhase('approving');
    try {
      const result = await approvePlanDelta(jobId);
      if (!mountedRef.current) return;
      const n = result.created.length;
      setApproveResult(t('nudge.approved', { count: n }));
      setPhase('done');
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof PlanEditsClientError) {
        setErrorCode(err.code ?? 'UNKNOWN');
      } else {
        setErrorCode('UNKNOWN');
      }
      setPhase('error');
    }
  }, [jobId, t]);

  const handleDecline = useCallback(() => {
    setVisible(false);
  }, []);

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

      {phase === 'review' && addedChildren ? (
        <ExpansionNudgeReview
          addedChildren={addedChildren}
          onApprove={handleApprove}
          onDecline={handleDecline}
          approving={false}
        />
      ) : phase === 'approving' ? (
        <ExpansionNudgeReview
          addedChildren={addedChildren ?? []}
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
