'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, ListChecks, Lock, Sparkles, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DirectionDocView } from './DirectionDocView';
import { CascadeBackBanner } from './CascadeBackBanner';
import { RevisionDiff } from './RevisionDiff';
import { RevisionLog } from './RevisionLog';
import type {
  DirectionDocKind,
  DirectionDocView as DirectionDocModel,
  FeatureCatalogView,
} from '@/lib/onboarding/directionDoc';
import type { PreplanRevisionDTO } from '@/lib/dto/aiPreplan';
import { latestRevision } from '@/lib/onboarding/revisions';

/** The on-page validate-demand-first decision (MOTIR-1064) shown on the validation
 *  tier; when present it BLOCKS Continue until the user picks an option. */
export interface ValidateDecision {
  onProveDemand: () => void;
  onBuildItAll: () => void;
}

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
  /** This tier's forward revision log (newest-first) — drives the per-revision
   *  diff + the revision-log viewer (Subtask 7.3.71 / MOTIR-1179). */
  revisions: PreplanRevisionDTO[];
  /** This tier is the attributed target of an active downstream cascade (G3) —
   *  show the going-back banner above the doc. */
  cascadeActive?: boolean;
  /** The downstream tiers re-deriving in the active cascade ("will refresh"). */
  willRefresh?: DirectionDocKind[];
  /** The structured feature catalog — folded into the VISION tier's review by
   *  `DirectionDocView` (ignored for every other tier). Null when undrafted. */
  catalog?: FeatureCatalogView | null;
  /** Re-open another produced tier (cross-link / hub navigation). */
  onNavigate?: (kind: DirectionDocKind) => void;
  /** Present on the validation tier with the blocking ask parked — renders the
   *  on-page decision block and BLOCKS Continue until the user chooses. */
  validateDecision?: ValidateDecision;
  onBack: () => void;
  onContinue: () => void;
  /** A turn is in flight — disable Continue so we don't double-advance. */
  busy?: boolean;
}

export function TierReviewGate({
  doc,
  availableKinds,
  revisions,
  cascadeActive = false,
  willRefresh = [],
  catalog = null,
  validateDecision,
  onBack,
  onContinue,
  busy = false,
  onNavigate,
}: TierReviewGateProps) {
  const t = useTranslations('onboarding.chat');
  const tr = useTranslations('onboarding.chat.revisions');
  // The validate-demand-first decision gates Continue: until the user picks an
  // option on the page (or in the chat), advancing is blocked (MOTIR-1064).
  const blockedByDecision = validateDecision !== undefined;
  // The newest revision of this tier (null when never revised) — the WHAT the gate
  // surfaces prominently; the full history sits below in the log viewer (1179).
  const latest = latestRevision(revisions);

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
          {cascadeActive && <CascadeBackBanner willRefresh={willRefresh} />}

          <DirectionDocView
            doc={doc}
            catalog={catalog}
            availableDocs={availableKinds}
            onNavigate={onNavigate}
          />

          {latest && (
            <section
              className="mt-6 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding)"
              aria-label={tr('whatChangedTitle')}
            >
              <header className="mb-2 flex items-center gap-2">
                <Sparkles className="size-4 text-(--el-accent-on-surface)" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-(--el-text)">{tr('whatChangedTitle')}</h2>
              </header>
              <RevisionDiff diff={latest.diff} />
            </section>
          )}

          <RevisionLog versions={revisions} currentVersion={doc.version ?? 1} />

          {validateDecision && (
            <section
              className="mt-8 rounded-(--radius-card) bg-(--el-tint-peach) p-(--spacing-card-padding)"
              aria-label={t('validate.title')}
            >
              <div className="flex items-start gap-2">
                <Lock
                  className="mt-0.5 size-4 shrink-0 text-(--el-text-strong)"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-semibold text-(--el-text-strong)">{t('validate.title')}</p>
                  <p className="mt-1 text-sm text-(--el-text-strong)">{t('validate.body')}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<ListChecks className="size-4" />}
                  onClick={validateDecision.onProveDemand}
                  disabled={busy}
                >
                  {t('proveDemandLabel')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={validateDecision.onBuildItAll}
                  disabled={busy}
                >
                  {t('buildItAllLabel')}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>

      {/* Bottom-LOCKED action bar (MOTIR-1365): Back + Continue stay in ONE row,
          pinned below the scrolling doc on EVERY tier step — so a long doc (e.g.
          the validation "Will people want it?" tier) never hides them. */}
      <div className="shrink-0 border-t border-(--el-border) bg-(--el-surface) px-4 py-3">
        <div className="mx-auto flex max-w-[48rem] items-center gap-3">
          <Button variant="secondary" leftIcon={<ArrowLeft className="size-4" />} onClick={onBack}>
            {t('back')}
          </Button>
          <span className="hidden items-center gap-1.5 text-xs text-(--el-text-muted) sm:flex">
            {blockedByDecision ? (
              <>
                <Lock className="size-4 text-(--el-text-faint)" aria-hidden="true" />
                {t('validate.blockedNote')}
              </>
            ) : (
              <>
                <Unlock className="size-4 text-(--el-text-faint)" aria-hidden="true" />
                {t('gateNote')}
              </>
            )}
          </span>
          <span className="grow" />
          <Button
            variant="primary"
            size="lg"
            rightIcon={<ArrowRight className="size-4" />}
            onClick={onContinue}
            loading={busy}
            disabled={busy || blockedByDecision}
          >
            {t('continueLabel')}
          </Button>
        </div>
      </div>
    </section>
  );
}
