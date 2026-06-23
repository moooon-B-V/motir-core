'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, ListChecks, Lock, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { AiPaywall, AI_OUT_OF_CREDITS_CODE, resolveAiPaywall } from '@/components/ai/AiPaywall';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import type { ChatTurn, ValidateEarlyAsk, WorkingState } from '@/lib/onboarding/discoveryLoop';

// The discovery CHAT RAIL (Subtask 7.3.5 / MOTIR-833, design screen C/G2 right
// rail) — the SOLE input to the onboarding loop. Free-form talk drives the
// conductor; there is NO inline doc editing anywhere. It renders the streamed
// conductor turns, the "thinking / drafting" indicator, the one blocking
// validate-demand-first decision (MOTIR-1064), an optional-tier Skip affordance
// (a chat decision, per the conversation-only model), and the composer.
//
// Purely presentational: every action is a chat turn the parent forwards to the
// loop via `onSend` (Continue lives on the review gate, not here). The shell
// (MOTIR-840) composes this rail beside the canvas roadmap.

export interface DiscoveryChatRailProps {
  turns: ChatTurn[];
  working: WorkingState | null;
  isStreaming: boolean;
  /** The blocking validate-demand-first ask, when parked. */
  pendingAsk: ValidateEarlyAsk | null;
  /** Whether an optional check is still ahead (offer a Skip chat decision). */
  canSkip: boolean;
  error: { code: string; message: string | null } | null;
  /** The member-safe AI entitlement (Subtask 8.1.8) — drives the boundary paywall. */
  aiAccess?: AiAccessDTO | null;
  /** Forward a chat turn (free-form, a decision chip, or a skip) to the loop. */
  onSend: (text: string) => void;
  onDismissError: () => void;
}

export function DiscoveryChatRail({
  turns,
  working,
  isStreaming,
  pendingAsk,
  canSkip,
  error,
  aiAccess,
  onSend,
  onDismissError,
}: DiscoveryChatRailProps) {
  const t = useTranslations('onboarding.chat');
  const [draft, setDraft] = useState('');
  const [paywallDismissed, setPaywallDismissed] = useState(false);

  // The AI-boundary paywall (8.1.8): a reactive out-of-credits refusal (the stream
  // error frame's typed code) OR a proactive entitlement block (cloud + balance ≤
  // 0). When active it REPLACES the generic error banner, the composer is gated,
  // and the upsell carries the right owner/member · out-of-credits/tier-gate face.
  const reactiveOutOfCredits = error?.code === AI_OUT_OF_CREDITS_CODE;
  const paywall = resolveAiPaywall(aiAccess ?? null, reactiveOutOfCredits);
  const showPaywall = paywall !== null && (reactiveOutOfCredits || !paywallDismissed);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || isStreaming || showPaywall) return;
    onSend(text);
    setDraft('');
  }

  const showAsk = pendingAsk !== null && !isStreaming && !showPaywall;
  const showSkip = canSkip && !showAsk && !isStreaming && !showPaywall;

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
      aria-label={t('railLabel')}
    >
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="size-2 rounded-full bg-(--el-success)" aria-hidden="true" />
        <span className="font-mono text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
          {t('railLabel')}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" role="log">
        {turns.map((turn) => (
          <Bubble key={turn.id} turn={turn} assistantInitial={t('assistantInitial')} />
        ))}

        {working && (
          <div className="flex items-start gap-2">
            <Avatar role="assistant" initial={t('assistantInitial')} />
            <div className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2 text-sm text-(--el-text-muted)">
              <Spinner size="sm" aria-hidden="true" />
              {working.phase === 'drafting' ? t('drafting') : t('working')}
            </div>
          </div>
        )}

        {/* A non-paywall stream error keeps the generic banner; an out-of-credits
            refusal becomes the paywall below instead. */}
        {error && !reactiveOutOfCredits && (
          <div className="rounded-(--radius-card) bg-(--el-tint-rose) px-3 py-2 text-sm text-(--el-text-strong)">
            <p>{t('errorBody')}</p>
            <button
              type="button"
              onClick={onDismissError}
              className="mt-1 font-medium text-(--el-link) underline-offset-2 hover:underline"
            >
              {t('dismiss')}
            </button>
          </div>
        )}

        {showPaywall && (
          <AiPaywall
            access={aiAccess ?? null}
            triggeredOutOfCredits={reactiveOutOfCredits}
            onDismiss={reactiveOutOfCredits ? onDismissError : () => setPaywallDismissed(true)}
          />
        )}
      </div>

      {showAsk && (
        <div className="flex flex-col gap-2 border-t border-(--el-border-soft) px-4 py-3">
          <Button
            variant="primary"
            size="sm"
            leftIcon={<ListChecks className="size-4" />}
            onClick={() => onSend(t('replies.proveDemand'))}
          >
            {t('proveDemandLabel')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onSend(t('replies.buildItAll'))}>
            {t('buildItAllLabel')}
          </Button>
          <p className="flex items-start gap-1.5 text-xs text-(--el-text-muted)">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
            {t('validateLockNote')}
          </p>
        </div>
      )}

      {showSkip && (
        <div className="flex flex-col gap-1.5 border-t border-(--el-border-soft) px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowRight className="size-4" />}
            onClick={() => onSend(t('replies.skip'))}
            className="self-start"
          >
            {t('skipLabel')}
          </Button>
          <p className="text-xs text-(--el-text-muted)">{t('skipHint')}</p>
        </div>
      )}

      <form
        onSubmit={submit}
        className="flex items-center gap-2 border-t border-(--el-border) px-3 py-3"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={isStreaming || showPaywall}
          placeholder={t('composerPlaceholder')}
          aria-label={t('composerPlaceholder')}
          className="h-(--height-input) min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) px-(--spacing-input-x) text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={isStreaming || showPaywall || draft.trim().length === 0}
          aria-label={t('send')}
        >
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </form>
    </aside>
  );
}

function Bubble({ turn, assistantInitial }: { turn: ChatTurn; assistantInitial: string }) {
  const isUser = turn.role === 'user';
  return (
    <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <Avatar role={turn.role} initial={assistantInitial} />
      <div
        className={
          isUser
            ? 'rounded-(--radius-card) bg-(--el-accent) px-3 py-2 text-sm text-(--el-accent-text)'
            : 'rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-2 text-sm text-(--el-text)'
        }
      >
        {turn.text}
      </div>
    </div>
  );
}

function Avatar({ role, initial }: { role: ChatTurn['role']; initial: string }) {
  const isUser = role === 'user';
  return (
    <span
      aria-hidden="true"
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
        isUser
          ? 'bg-(--el-muted) text-(--el-text-secondary)'
          : 'bg-(--el-accent) text-(--el-accent-text)'
      }`}
    >
      {isUser ? '·' : initial}
    </span>
  );
}
