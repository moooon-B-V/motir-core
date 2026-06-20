'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DiscoveryChatRail } from './DiscoveryChatRail';
import { TierReviewGate } from './TierReviewGate';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { clearPendingIdeaAction } from '@/app/(onboarding)/onboarding/actions';
import { useDiscoveryChat } from '@/lib/hooks/useDiscoveryChat';
import { activeDoc, isTiersComplete } from '@/lib/onboarding/discoveryLoop';
import {
  DIRECTION_DOC_ORDER,
  TIER_META,
  type DirectionDocKind,
} from '@/lib/onboarding/directionDoc';

// The authed discovery onboarding root (Subtask 7.3.5 / MOTIR-833) — the client
// island that drives the FORWARD gated review loop. It is a FULL-SCREEN, two-pane
// surface (it renders OUTSIDE the app shell, via the `(onboarding)` route group):
// the canvas roadmap on the LEFT, the chat rail on the RIGHT — nothing else. When
// a tier is up for review the read-only gate takes the whole screen. Conversation
// is the only input; Continue is navigation, not sign-off (nothing locks until
// generation).
//
// SCOPE BOUNDARY: the RICH canvas roadmap (stations with captured findings, the
// idea node + connectors, "you are here", the post-plan epic/story canvas) is the
// onboarding shell, Subtask 7.3.11 / MOTIR-840, which COMPOSES the pieces here.
// So the left pane below is a DELIBERATELY MINIMAL roadmap that 840 enriches — it
// is the canvas slot, not an extra component. The "Go to plan phase" exit is
// Subtask 7.3.28 / MOTIR-1041; we draw the disabled slot and leave its wiring
// to 1041.

export interface DiscoveryOnboardingProps {
  /** The idea preserved across the auth redirect (the 7.3.14 cookie), seeded as
   *  the first turn for a fresh session. */
  initialIdea: string | null;
}

export function DiscoveryOnboarding({ initialIdea }: DiscoveryOnboardingProps) {
  const t = useTranslations('onboarding.chat');
  const { state, send, continueTier, openTier, back, dismissError } = useDiscoveryChat({
    initialIdea,
  });

  // The loop seeds the first turn from the preserved idea (the 7.3.14 cookie);
  // clear that cookie once, on mount, so it can't re-seed a later visit (the
  // mutation half of the read-in-render / clear-in-action seam).
  const clearedRef = useRef(false);
  useEffect(() => {
    if (initialIdea && !clearedRef.current) {
      clearedRef.current = true;
      void clearPendingIdeaAction();
    }
  }, [initialIdea]);

  const reviewing = state.view === 'review' ? activeDoc(state) : null;
  const complete = isTiersComplete(state);
  const canSkip =
    !state.isStreaming &&
    state.producedKinds.includes('vision') &&
    !state.producedKinds.includes('validation') &&
    state.pendingAsk === null &&
    !complete;

  if (reviewing) {
    return (
      <div className="h-dvh w-full">
        <TierReviewGate
          doc={reviewing}
          availableKinds={state.producedKinds}
          onNavigate={openTier}
          onBack={back}
          onContinue={() => continueTier(t('replies.continue'))}
          busy={state.isStreaming}
        />
      </div>
    );
  }

  // The hub: the reusable full-screen two-pane workspace — canvas (left) + chat
  // (right). Onboarding fills the panes with its own (specialized) canvas + chat;
  // the SHELL is shared (PlanningWorkspace), so generation / re-planning /
  // contextual planning reuse the identical frame.
  return (
    <PlanningWorkspace
      canvas={
        <RoadmapCanvas
          producedKinds={state.producedKinds}
          activeKind={state.activeKind}
          complete={complete}
          empty={state.turns.length === 0 && state.producedKinds.length === 0}
          onOpen={openTier}
        />
      }
      chat={
        <DiscoveryChatRail
          turns={state.turns}
          working={state.working}
          isStreaming={state.isStreaming}
          pendingAsk={state.pendingAsk}
          canSkip={canSkip}
          error={state.error}
          onSend={send}
          onDismissError={dismissError}
        />
      }
    />
  );
}

// The LEFT pane — the pre-plan canvas roadmap, in minimal form (840 enriches it
// with captured findings + the post-plan epic/story tree). A vertical pipeline of
// the pre-plan stations; a produced tier is clickable to re-open its read-only
// review.
function RoadmapCanvas({
  producedKinds,
  activeKind,
  complete,
  empty,
  onOpen,
}: {
  producedKinds: DirectionDocKind[];
  activeKind: DirectionDocKind | null;
  complete: boolean;
  empty: boolean;
  onOpen: (kind: DirectionDocKind) => void;
}) {
  const t = useTranslations('onboarding.chat');

  return (
    <section className="min-h-0 overflow-y-auto px-6 py-6" aria-label={t('progressTitle')}>
      <header className="mb-5">
        <h2 className="font-serif text-lg font-semibold text-(--el-text)">{t('progressTitle')}</h2>
        <span className="font-mono text-xs text-(--el-text-faint)">{t('progressCaption')}</span>
      </header>

      {empty ? (
        <div className="rounded-(--radius-card) border border-dashed border-(--el-border) px-4 py-6 text-center">
          <p className="font-medium text-(--el-text)">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-(--el-text-muted)">{t('emptyBody')}</p>
        </div>
      ) : (
        <ol className="flex flex-col">
          {DIRECTION_DOC_ORDER.map((kind, i) => {
            const produced = producedKinds.includes(kind);
            const isActive = activeKind === kind;
            const meta = TIER_META[kind];
            const last = i === DIRECTION_DOC_ORDER.length - 1;
            return (
              <li key={kind} className="flex gap-3">
                {/* the pipeline rail: a state node + the connector line down */}
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1 flex size-5 shrink-0 items-center justify-center rounded-full ${
                      produced
                        ? 'bg-(--el-success) text-(--el-accent-text)'
                        : isActive
                          ? 'bg-(--el-accent) text-(--el-accent-text)'
                          : 'bg-(--el-muted) text-(--el-text-faint)'
                    }`}
                    aria-hidden="true"
                  >
                    {produced ? (
                      <Check className="size-3" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-current" />
                    )}
                  </span>
                  {!last && <span className="my-1 w-px grow bg-(--el-border)" />}
                </div>
                {/* the station */}
                <button
                  type="button"
                  disabled={!produced}
                  onClick={() => onOpen(kind)}
                  className={`mb-2 min-w-0 flex-1 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y) text-left transition-colors ${
                    isActive
                      ? 'border-(--el-accent) bg-(--el-surface-soft)'
                      : 'border-(--el-border-soft) bg-(--el-surface)'
                  } ${produced ? 'hover:bg-(--el-surface-soft)' : 'opacity-60'}`}
                >
                  <span className="block truncate text-sm font-medium text-(--el-text)">
                    {meta.label}
                  </span>
                  <span className="block truncate text-xs text-(--el-text-muted)">
                    {meta.kicker}
                    {meta.optional ? ` · ${t('skipLabel')}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {complete && (
        <div className="mt-5 rounded-(--radius-card) bg-(--el-tint-mint) px-4 py-4">
          <p className="font-medium text-(--el-text-strong)">{t('completeTitle')}</p>
          <p className="mt-1 text-sm text-(--el-text-strong)">{t('completeBody')}</p>
          {/* The "Go to plan phase" exit is Subtask 7.3.28 / MOTIR-1041 — drawn as
              the disabled slot here, wired by that card. */}
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            disabled
            rightIcon={<ArrowRight className="size-4" />}
            title={t('goToPlanSoon')}
          >
            {t('goToPlanLabel')}
          </Button>
        </div>
      )}
    </section>
  );
}
