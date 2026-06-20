'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DirectionDocView } from './DirectionDocView';
import type {
  DirectionDocKind,
  DirectionDocView as DirectionDocModel,
} from '@/lib/onboarding/directionDoc';

// The full-screen per-tier REVIEW GATE (Subtask 7.3.5 / MOTIR-833, design
// screens D–G + the gate footer). It wraps 834's read-only `DirectionDocView`
// with the gate FLOW chrome this card owns: a "Back" + descriptive header step
// bar, and the footer Continue gate. The doc body is READ-ONLY — the user reacts
// only in the chat (no inline edit anywhere); "Continue" is navigation, not
// sign-off (nothing locks until the plan generates).
//
// Per-doc DIFFS, the revision LOG, and the downstream cascade-BACK are Subtask
// 7.3.71 / MOTIR-1179 — deliberately NOT here. The polished full-screen step
// HOST that swaps this into the two-pane shell (and hosts the design step) is the
// onboarding shell, Subtask 7.3.11 / MOTIR-840, which COMPOSES this gate.

export interface TierReviewGateProps {
  doc: DirectionDocModel;
  /** The other produced tiers, for the doc's cross-link footer. */
  availableKinds: DirectionDocKind[];
  /** Re-open another produced tier (cross-link / hub navigation). */
  onNavigate?: (kind: DirectionDocKind) => void;
  onBack: () => void;
  onContinue: () => void;
  /** A turn is in flight — disable Continue so we don't double-advance. */
  busy?: boolean;
}

export function TierReviewGate({
  doc,
  availableKinds,
  onNavigate,
  onBack,
  onContinue,
  busy = false,
}: TierReviewGateProps) {
  const t = useTranslations('onboarding.chat');

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-(--el-surface)"
      aria-label={t('stepHeader')}
    >
      <div className="flex items-center gap-3 border-b border-(--el-border) px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ArrowLeft className="size-4" />}
          onClick={onBack}
        >
          {t('back')}
        </Button>
        <span className="grow font-mono text-xs font-semibold uppercase tracking-wide text-(--el-text-faint)">
          {t('stepHeader')}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-[48rem]">
          <DirectionDocView
            doc={doc}
            catalog={null}
            availableDocs={availableKinds}
            onNavigate={onNavigate}
          />

          <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-5">
            <Button
              variant="secondary"
              leftIcon={<ArrowLeft className="size-4" />}
              onClick={onBack}
            >
              {t('back')}
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-(--el-text-muted)">
              <Unlock className="size-4 text-(--el-text-faint)" aria-hidden="true" />
              {t('gateNote')}
            </span>
            <span className="grow" />
            <Button
              variant="primary"
              size="lg"
              rightIcon={<ArrowRight className="size-4" />}
              onClick={onContinue}
              loading={busy}
              disabled={busy}
            >
              {t('continueLabel')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
