'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { DiscoveryChatRail } from './DiscoveryChatRail';
import { TierReviewGate } from './TierReviewGate';
import { clearPendingIdeaAction } from '@/app/(authed)/onboarding/actions';
import { useDiscoveryChat } from '@/lib/hooks/useDiscoveryChat';
import { activeDoc, isTiersComplete } from '@/lib/onboarding/discoveryLoop';
import {
  DIRECTION_DOC_ORDER,
  TIER_META,
  type DirectionDocKind,
} from '@/lib/onboarding/directionDoc';

// The authed discovery onboarding root (Subtask 7.3.5 / MOTIR-833) — the client
// island that drives the FORWARD gated review loop: a HUB (a pre-plan progress
// rail on the left + the chat rail on the right) that switches to a FULL-SCREEN
// read-only review gate when a tier is up for review. Conversation is the only
// input; Continue is navigation, not sign-off (nothing locks until generation).
//
// SCOPE BOUNDARY: the polished two-pane SHELL — the rich canvas ROADMAP (stations
// with captured findings, "you are here"), the full-screen step HOST, and the
// post-plan epic/story canvas — is the onboarding shell, Subtask 7.3.11 /
// MOTIR-840, which is `blocked_by` this card and COMPOSES the pieces here (the
// chat rail + the review gate). So the left rail below is a DELIBERATELY MINIMAL
// pre-plan progress strip that 840 supersedes with the designed canvas. The "Go
// to plan phase" exit is Subtask 7.3.28 / MOTIR-1041 (it sits on top of this
// card); we draw the disabled slot and leave its wiring to 1041.

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
      <div className="h-[calc(100dvh-var(--app-header-height,3.5rem))]">
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

  return (
    <div className="flex h-[calc(100dvh-var(--app-header-height,3.5rem))] min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-(--el-border) px-4 py-3">
        <span className="flex size-6 items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-(--el-accent-text)">
          <Sparkles className="size-3.5" aria-hidden="true" />
        </span>
        <span className="font-mono text-xs font-semibold uppercase tracking-wide text-(--el-text-faint)">
          {t('stepHeader')}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_22rem]">
        <ProgressRail
          producedKinds={state.producedKinds}
          activeKind={state.activeKind}
          complete={complete}
          empty={state.turns.length === 0 && state.producedKinds.length === 0}
          onOpen={openTier}
        />
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
      </div>
    </div>
  );
}

// The minimal pre-plan progress strip (840 replaces this with the canvas roadmap).
function ProgressRail({
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
    <section className="min-h-0 overflow-y-auto px-5 py-5" aria-label={t('progressTitle')}>
      <header className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="font-serif text-lg font-semibold text-(--el-text)">{t('progressTitle')}</h2>
        <span className="font-mono text-xs text-(--el-text-faint)">{t('progressCaption')}</span>
      </header>

      {empty ? (
        <div className="rounded-(--radius-card) border border-dashed border-(--el-border) px-4 py-6 text-center">
          <p className="font-medium text-(--el-text)">{t('emptyTitle')}</p>
          <p className="mt-1 text-sm text-(--el-text-muted)">{t('emptyBody')}</p>
        </div>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {DIRECTION_DOC_ORDER.map((kind) => {
            const produced = producedKinds.includes(kind);
            const isActive = activeKind === kind;
            const meta = TIER_META[kind];
            return (
              <li key={kind}>
                <button
                  type="button"
                  disabled={!produced}
                  onClick={() => onOpen(kind)}
                  className={`flex w-full items-center gap-3 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y) text-left transition-colors ${
                    isActive
                      ? 'border-(--el-accent) bg-(--el-surface-soft)'
                      : 'border-(--el-border-soft) bg-(--el-surface)'
                  } ${produced ? 'hover:bg-(--el-surface-soft)' : 'opacity-60'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-(--el-text)">
                      {meta.label}
                    </span>
                    <span className="block truncate text-xs text-(--el-text-muted)">
                      {meta.kicker}
                      {meta.optional ? ` · ${t('skipLabel')}` : ''}
                    </span>
                  </span>
                  {produced && (
                    <Pill status="done">
                      <Check className="size-3" aria-hidden="true" /> {/* reviewed */}
                    </Pill>
                  )}
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
