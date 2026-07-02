'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Palette } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { DiscoveryChatRail } from './DiscoveryChatRail';
import { OnboardingTopBar } from './OnboardingTopBar';
import { TierReviewGate } from './TierReviewGate';
import { DesignStep } from './DesignStep';
import { GenerationHandoff } from './GenerationHandoff';
import { GenerationFlow } from '@/components/planning/GenerationFlow';
import { OnboardingCanvas } from './OnboardingCanvas';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { clearPendingIdeaAction } from '@/app/(onboarding)/onboarding/actions';
import { useDiscoveryChat } from '@/lib/hooks/useDiscoveryChat';
import { useAiAccess } from '@/lib/hooks/useAiAccess';
import {
  activeDoc,
  activeRevisions,
  isTiersComplete,
  shouldShowDesignStep,
  willRefreshKinds,
} from '@/lib/onboarding/discoveryLoop';

// The onboarding SHELL (Subtask 7.3.11 / MOTIR-840) — the client island that
// composes the finalized two-pane onboarding into one frame with two modes: the
// HUB (the SPATIAL canvas roadmap on the LEFT + the chat rail on the RIGHT) and a
// FULL-SCREEN gated step (a read-only tier review, with a plain Back + descriptive
// header). It renders OUTSIDE the app shell via the `(onboarding)` route group.
//
// It COMPOSES the shipped surfaces — it does not re-implement them: the spatial
// `OnboardingCanvas` (PlanningCanvas, 7.3.76 + layout persistence, 7.3.77) on the
// left, 833's `DiscoveryChatRail` on the right, 834's read-only doc inside
// `TierReviewGate`. The cascade-back behaviour + canvas states are 7.3.71 /
// MOTIR-1179 (composed onto this canvas); the design step is 7.3.27 / MOTIR-1040;
// the "Go to plan" exit is 7.3.28 / MOTIR-1041 (drawn disabled here). Conversation
// is the only input; Continue is navigation, not sign-off (nothing locks).

// Where "Save & exit" returns the user (MOTIR-1488) — the app's default authed
// landing (the sign-in/sign-up callback target). An in-progress onboarding
// session is preserved server-side, so re-entering `/onboarding` resumes it.
const ONBOARDING_EXIT_PATH = '/dashboard';

export interface DiscoveryOnboardingProps {
  /** The idea preserved across the auth redirect (the 7.3.14 cookie), seeded as
   *  the first turn for a fresh session. */
  initialIdea: string | null;
  /** The active project's key — lets the canvas read the produced work-item tree
   *  (`/api/projects/[key]/roadmap`) and show the whole project, not just the
   *  pre-plan stations. */
  projectKey?: string;
  /** The active project's name — shown in the top bar (MOTIR-1488). */
  projectName?: string | null;
}

export function DiscoveryOnboarding({
  initialIdea,
  projectKey,
  projectName,
}: DiscoveryOnboardingProps) {
  const t = useTranslations('onboarding.chat');
  const {
    state,
    send,
    continueTier,
    decideValidateEarly,
    openTier,
    openDesign,
    enterGeneration,
    saveDesign,
    back,
    dismissError,
  } = useDiscoveryChat({ initialIdea });

  // The org's AI entitlement (Subtask 8.1.8) — drives the boundary paywall in the
  // chat rail (proactive tier-gate / out-of-credits block; reactive on a refusal).
  const { access: aiAccess } = useAiAccess();

  // Whether the 7.4 generation flow (MOTIR-1396) is running INSIDE the generation
  // hand-off view: the hand-off shows the frozen baseline + a "Generate" trigger;
  // pressing it mounts `GenerationFlow` (POST → live reveal → hand off to /plans).
  // It only flips back to the baseline via `GenerationFlow`'s `onExit`; leaving the
  // generation view entirely happens from the baseline (already false) or via the
  // /plans navigation (unmount), so no effect-driven reset is needed.
  const [generating, setGenerating] = useState(false);

  // "Save & exit" (MOTIR-1488). The onboarding window sits OUTSIDE the app shell,
  // so it carries its own exit. The composer draft is LIFTED here (from the chat
  // rail) so exit can confirm before discarding an unsent message; the produced
  // tier state is already persisted server-side, so leaving loses nothing else.
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [exitConfirm, setExitConfirm] = useState(false);

  // The loop seeds the first turn from the preserved idea (the 7.3.14 cookie);
  // clear that cookie once, on mount, so it can't re-seed a later visit.
  const clearedRef = useRef(false);
  useEffect(() => {
    if (initialIdea && !clearedRef.current) {
      clearedRef.current = true;
      void clearPendingIdeaAction();
    }
  }, [initialIdea]);

  // The contextual step caption for the top bar — "revisiting" once a cascade
  // re-opens an already-produced tier, else "building" (matches the mock).
  const stepLabel = t(state.cascade?.directTier ? 'topbarStepRevisiting' : 'topbarStep');

  const leaveOnboarding = () => router.push(ONBOARDING_EXIT_PATH);
  // A guard-free exit (the full-page-route model), EXCEPT when the composer holds
  // an unsent message — then a light confirm prevents silent loss (the produced
  // tiers are safe regardless). The chat rail only mounts on the hub, so `draft`
  // is empty on every other view and exit is a direct navigation there.
  const requestExit = () => {
    if (draft.trim().length > 0) setExitConfirm(true);
    else leaveOnboarding();
  };

  // Every onboarding view renders inside this frame: the persistent top bar (with
  // "Save & exit") above, the view below. The bar is present at EVERY step.
  const frame = (content: ReactNode) => (
    <div className="flex h-dvh w-full flex-col bg-(--el-page-bg)">
      <OnboardingTopBar projectName={projectName} stepLabel={stepLabel} onExit={requestExit} />
      <div className="min-h-0 flex-1">{content}</div>
      <Modal
        open={exitConfirm}
        onOpenChange={setExitConfirm}
        role="alertdialog"
        title={t('exitConfirmTitle')}
        description={t('exitConfirmBody')}
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setExitConfirm(false)}>
            {t('exitConfirmStay')}
          </Button>
          <Button variant="primary" size="sm" onClick={leaveOnboarding}>
            {t('exitConfirmLeave')}
          </Button>
        </div>
      </Modal>
    </div>
  );

  // RESUME hydration gate (MOTIR-1487). On a resume the persisted current step is
  // read async from motir-ai (`GET /api/ai/pre-plan`) AFTER mount, so before it
  // lands the loop holds its fresh-state default — which paints the FIRST station
  // ("Understanding your project") as "you are here". Rendering the hub then would
  // flash that wrong step before hydration swaps in the real step N. So while the
  // resume read is still in flight, show the shipped "Resuming…" loading state
  // (EmptyState + Spinner, per MOTIR-13) instead of the canvas. A FRESH visit
  // arrives WITH the preserved idea (`initialIdea`), where discovery genuinely IS
  // the current step — paint it immediately (no placeholder, no flash).
  if (state.hydrating && !initialIdea) {
    return frame(
      <div
        aria-busy="true"
        className="flex h-full w-full items-center justify-center bg-(--el-surface-soft)"
      >
        <EmptyState
          icon={<Spinner size="lg" aria-label={t('resuming')} />}
          title={t('resuming')}
          description={t('resumingBody')}
        />
      </div>,
    );
  }

  const reviewing = state.view === 'review' ? activeDoc(state) : null;
  const complete = isTiersComplete(state);
  // The design-phase gate (7.3.69): the design step (button + canvas station +
  // full-screen view) is offered only for a web / desktop project; a mobile /
  // other project skips it (the conductor-inferred `session.platform`).
  const showDesign = shouldShowDesignStep(state.session.platform);
  const canSkip =
    !state.isStreaming &&
    state.producedKinds.includes('vision') &&
    !state.producedKinds.includes('validation') &&
    state.pendingAsk === null &&
    !complete;

  // The seed idea for the canvas idea node: the preserved cookie on a fresh visit,
  // else the first user turn (the idea is opaque inside a resumed session).
  const idea = initialIdea ?? state.turns.find((turn) => turn.role === 'user')?.text ?? null;

  // The web-only full-page design step (MOTIR-1040) — styles its whole self via
  // the shipped three-axis runtime. It RESTORES the saved choice via `initialChoice`
  // (7.3.81) and "Use this design" PERSISTS it (optimistic + best-effort) before
  // returning to the hub (the plan exit is MOTIR-1041).
  if (state.view === 'design' && showDesign) {
    return frame(
      <DesignStep
        onBack={back}
        initialChoice={state.session.designChoice}
        onUseDesign={(choice) => {
          saveDesign(choice);
          back();
        }}
      />,
    );
  }

  // The pre-plan → generation HAND-OFF (Subtask 7.3.28 / MOTIR-1041) — the LAST
  // 7.3 affordance, entered from the hub's "Plan → your project" exit once the
  // tiers are complete. It freezes the already-persisted baseline as generation's
  // input and hands off to 7.4; Back re-enters the loop (the baseline is revisable,
  // not locked). It does NOT generate the tree — that is 7.4.
  if (state.view === 'generation') {
    return frame(
      generating ? (
        // 7.4 generation entry (MOTIR-1396) — runs the job + reveals proposals
        // live, then hands off to /plans/:id; Back returns to the baseline.
        <GenerationFlow onExit={() => setGenerating(false)} />
      ) : (
        <GenerationHandoff
          onBack={back}
          onGenerate={() => setGenerating(true)}
          reviewedCount={state.producedKinds.length}
          designChoice={state.session.designChoice}
          designApplied={showDesign}
        />
      ),
    );
  }

  if (reviewing) {
    // The blocking validate-demand-first decision (MOTIR-1064) appears ON the
    // validation page too (not only in the chat) and gates Continue there.
    const validateDecision =
      reviewing.kind === 'validation' && state.pendingAsk
        ? {
            onProveDemand: () => decideValidateEarly(t('replies.proveDemand')),
            onBuildItAll: () => decideValidateEarly(t('replies.buildItAll')),
          }
        : undefined;
    return frame(
      <TierReviewGate
        doc={reviewing}
        availableKinds={state.producedKinds}
        revisions={activeRevisions(state)}
        cascadeActive={state.cascade?.directTier === reviewing.kind}
        willRefresh={willRefreshKinds(state)}
        catalog={state.catalog}
        validateDecision={validateDecision}
        onNavigate={openTier}
        onBack={back}
        onContinue={() => continueTier(t('replies.continue'))}
        busy={state.isStreaming}
      />,
    );
  }

  // The hub: the reusable full-screen two-pane workspace — canvas (left) + chat
  // (right). The spatial canvas fills its pane; the "Go to plan" exit (1041)
  // floats over it when the tiers are complete.
  return frame(
    <PlanningWorkspace
      className="h-full w-full"
      canvas={
        <div className="relative h-full min-h-0 w-full">
          {/* The design step (MOTIR-1040) is Step 5 — reachable only once the tiers
              are complete (and only for a web/desktop project — the 7.3.69 gate),
              from the `design` station on the canvas or this top-right shortcut
              (shown alongside the station's own entry CTA); the conductor also
              offers it in chat (cross-repo, MOTIR-1099). */}
          <OnboardingCanvas
            state={state}
            idea={idea}
            projectKey={projectKey}
            onOpenDesign={openDesign}
            onContinueStep={() => continueTier(t('replies.continue'))}
            onReviewStep={openTier}
            revisitingKind={state.cascade?.directTier ?? null}
            willRefresh={willRefreshKinds(state)}
          />
          {/* Stacked BELOW the canvas's own top-right search overlay (the reusable
              foundation owns `top-3 right-3`); sharing the corner made the search
              input intercept this button's clicks (E2E regression). */}
          {showDesign && complete && (
            <Button
              variant="secondary"
              size="sm"
              className="absolute top-20 right-4 bg-(--el-page-bg)"
              leftIcon={<Palette className="size-4" />}
              onClick={openDesign}
            >
              {t('designLook')}
            </Button>
          )}
          {complete && (
            <div className="absolute right-4 bottom-4 max-w-[20rem] rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-mint) px-4 py-4 shadow-(--shadow-card)">
              <p className="font-medium text-(--el-text-strong)">{t('completeTitle')}</p>
              <p className="mt-1 text-sm text-(--el-text-strong)">{t('completeBody')}</p>
              {/* The "Go to plan phase" exit (Subtask 7.3.28 / MOTIR-1041) — the
                  LAST 7.3 affordance. Clicking IS the confirmation (no modal, no
                  readiness gate): it enters the generation hand-off, freezing the
                  baseline and handing off to 7.4. */}
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                rightIcon={<ArrowRight className="size-4" />}
                onClick={enterGeneration}
              >
                {t('goToPlanLabel')}
              </Button>
            </div>
          )}
        </div>
      }
      chat={
        <DiscoveryChatRail
          turns={state.turns}
          working={state.working}
          isStreaming={state.isStreaming}
          pendingAsk={state.pendingAsk}
          canSkip={canSkip}
          error={state.error}
          aiAccess={aiAccess}
          draft={draft}
          onDraftChange={setDraft}
          onSend={send}
          onDismissError={dismissError}
        />
      }
    />,
  );
}
