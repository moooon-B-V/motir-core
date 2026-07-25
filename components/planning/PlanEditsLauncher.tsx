'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PlanEditsReviewDock } from '@/components/planning/PlanEditsReviewDock';
import { usePlanEditsJob, type PlanEditsJobKind } from '@/lib/hooks/usePlanEditsJob';

export function AugmentPromptButton() {
  const t = useTranslations('planEdits');
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const { state, startJob, approve, cancel, dismissReview } = usePlanEditsJob();

  if (state.phase === 'done') {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-full max-w-lg">
        <PlanEditsReviewDock
          state={state}
          onApprove={approve}
          onCancel={cancel}
          onDismiss={dismissReview}
        />
      </div>
    );
  }

  if (state.phase !== 'idle') {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-full max-w-lg">
        <PlanEditsReviewDock
          state={state}
          onApprove={approve}
          onCancel={cancel}
          onDismiss={dismissReview}
        />
      </div>
    );
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Sparkles className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        {t('augmentPromptLabel')}
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={t('augmentPromptLabel')} size="sm">
        <div className="flex flex-col gap-3">
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('augmentPromptPlaceholder')}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Sparkles className="h-4 w-4" />}
              disabled={!prompt.trim()}
              onClick={() => {
                setOpen(false);
                startJob('augment', { prompt: prompt.trim() });
              }}
            >
              {t('augmentPromptSubmit')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export interface PlanEditsTriggerProps {
  /** The kind of job — expand or replan. */
  kind: 'expand' | 'replan';
  /** The work item identifier (PROD-123). */
  itemKey: string;
  /** Triggered when the user dismisses the review without completing it. */
  onDismiss?: () => void;
}

/**
 * A self-contained trigger for expand/replan jobs. Mount it and it
 * auto-starts the job, rendering the review dock when results arrive.
 */
export function PlanEditsTrigger({ kind, itemKey, onDismiss }: PlanEditsTriggerProps) {
  const { state, startJob, approve, cancel, dismissReview } = usePlanEditsJob();
  const startedRef = useRef<string | null>(null);

  // Auto-start on mount (and re-start if itemKey changes).
  useEffect(() => {
    if (startedRef.current !== itemKey) {
      startedRef.current = itemKey;
      startJob(kind as PlanEditsJobKind, { itemKey });
    }
  }, [kind, itemKey, startJob]);

  const handleDismiss = () => {
    startedRef.current = null;
    dismissReview();
    onDismiss?.();
  };

  if (state.phase !== 'idle' && state.phase !== 'done') {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-full max-w-lg">
        <PlanEditsReviewDock
          state={state}
          onApprove={approve}
          onCancel={cancel}
          onDismiss={handleDismiss}
        />
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-full max-w-lg">
        <PlanEditsReviewDock
          state={state}
          onApprove={approve}
          onCancel={cancel}
          onDismiss={handleDismiss}
        />
      </div>
    );
  }

  return null;
}
