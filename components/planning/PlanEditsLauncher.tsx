'use client';

import { useEffect, useRef } from 'react';
import { PlanEditsReviewDock } from '@/components/planning/PlanEditsReviewDock';
import { usePlanEditsJob, type PlanEditsJobKind } from '@/lib/hooks/usePlanEditsJob';

// The dock's fixed bottom-right shell. Arbitrary `max-w-[32rem]`, NOT
// `max-w-lg` — this project's Tailwind `@theme` defines the `--spacing-*`
// namespace, so Tailwind v4 resolves `max-w-lg` to `var(--spacing-lg)` (20px)
// instead of the default `--container-lg` (32rem), collapsing the dock to a
// ~20px sliver whose footer buttons overflow off-screen. Same trap documented
// in app/(authed)/reports/_components/ReportPageChrome.tsx.
const DOCK_SHELL = 'fixed bottom-6 right-6 z-50 w-full max-w-[32rem]';

// NOTE — the one-shot `AugmentPromptButton` (a toolbar `Button` → `Modal` with a
// single `Input` → `POST /api/ai/augment`) was RETIRED by MOTIR-1731. Changing a
// plan is a CONVERSATION, so the entrance is the universal Plan-with-AI workspace
// (the global `TopNav` pill / ⌘K / the floating orb), never a per-surface button
// with no way to refine. See design/ai-chat/design-notes.md ("the retired
// 'Augment from prompt' door", MOTIR-1727) panel 5. The `/api/ai/augment` job
// path itself is UNTOUCHED — the conversation drives it.

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
  const { state, startJob, approve, discard } = usePlanEditsJob();
  const startedRef = useRef<string | null>(null);

  // Auto-start on mount (and re-start if itemKey changes).
  useEffect(() => {
    if (startedRef.current !== itemKey) {
      startedRef.current = itemKey;
      startJob(kind as PlanEditsJobKind, { itemKey });
    }
  }, [kind, itemKey, startJob]);

  // Closing WITH a pending proposal declines its Plan (MOTIR-1747) — abandoning
  // it client-side would leave the run at `planned` forever, which the auto-plan
  // pause reads as a proposal still awaiting review. The dock unmounts once the
  // hook returns to `idle`.
  const handleClose = () => {
    startedRef.current = null;
    void discard();
    onDismiss?.();
  };

  // Idle with an error is a SETTLED failure the dock still has to say out loud
  // (out of credits / nothing proposed / the job died); idle without one is
  // nothing running.
  if (state.phase === 'idle' && !state.errorCode) return null;

  return (
    <div className={DOCK_SHELL}>
      <PlanEditsReviewDock
        state={state}
        onApprove={approve}
        onDiscard={handleClose}
        onDismiss={handleClose}
      />
    </div>
  );
}
