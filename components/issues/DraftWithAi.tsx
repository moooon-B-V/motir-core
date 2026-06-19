'use client';

import { useTranslations } from 'next-intl';
import { Sparkles, RotateCcw, Square, TriangleAlert, Plug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { DraftPhase } from '@/lib/hooks/useExplanationDraft';

// The shared "Draft with AI" affordance (Subtask 8.8.12) — the button + its
// states + the cloud-gate / stream-failed notices, reused by the create modal
// and the edit form so both render the identical design
// (design/work-items/draft-with-ai). The drafting LOGIC lives in
// useExplanationDraft; these are the presentational pieces, copy from the shared
// `draftWithAi` i18n namespace.

// The connect destination for the cloud-gate CTA: the self-host AI-connection
// docs (the same external-docs-link pattern ApiTokensManager uses for the MCP
// guide). There is no in-app connect flow — connecting Motir AI is an
// env/ops action (MOTIR_AI_URL + MOTIR_AI_SERVICE_TOKEN), documented here.
const CONNECT_AI_HREF = 'https://github.com/moooon-B-V/motir-core/blob/main/docs/ai-boundary.md';

export interface DraftWithAiButtonProps {
  phase: DraftPhase;
  /** Whether a draft has been produced this session (idle → "Regenerate"). */
  hasDraft: boolean;
  /** Server-resolved: is motir-core wired to a Motir AI deployment? */
  aiConfigured: boolean;
  /** Other reasons to disable (e.g. the form is submitting, or no title yet). */
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

// The single button that drives drafting. Three resting faces: idle ("Draft with
// AI" / "Regenerate"), drafting ("Drafting…" + Stop), and cloud-gated (disabled
// + tooltip). Always `ml-auto` so it rides the right of its header/label row.
export function DraftWithAiButton({
  phase,
  hasDraft,
  aiConfigured,
  disabled,
  onStart,
  onStop,
}: DraftWithAiButtonProps) {
  const t = useTranslations('draftWithAi');

  if (phase === 'drafting') {
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="ml-auto"
        onClick={onStop}
        aria-label={t('stop')}
        title={t('stop')}
      >
        <span className="flex items-center gap-1.5">
          <RotateCcw className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t('drafting')}
          <span className="mx-0.5 h-4 w-px bg-(--el-border-strong)" aria-hidden />
          <Square className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="ml-auto"
      leftIcon={
        hasDraft ? (
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
        )
      }
      disabled={disabled || !aiConfigured}
      title={!aiConfigured ? t('gateTooltip') : undefined}
      onClick={onStart}
    >
      {hasDraft ? t('regenerate') : t('button')}
    </Button>
  );
}

// 3A · Cloud-gated — shown below the editor when motir-core has no Motir AI
// connection. A yellow tint callout (finding #35: hue in the tint, AA text)
// pairing a plug glyph + heading + a "Connect Motir AI" docs link.
export function DraftGateNotice() {
  const t = useTranslations('draftWithAi');
  return (
    <Card tint="yellow" className="flex items-start gap-2.5 p-3">
      <Plug className="mt-0.5 h-5 w-5 shrink-0 text-(--el-warning)" aria-hidden />
      <div className="flex flex-col gap-1.5">
        <span className="text-(--el-text-strong) text-sm font-medium">{t('gateTitle')}</span>
        <span className="text-(--el-text-strong) text-xs">{t('gateBody')}</span>
        <a
          href={CONNECT_AI_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex w-fit"
        >
          <Button type="button" size="sm" variant="primary" tabIndex={-1}>
            {t('connect')}
          </Button>
        </a>
      </div>
    </Card>
  );
}

export interface DraftErrorNoticeProps {
  onRetry: () => void;
  onDismiss: () => void;
}

// 3B · Stream failed — shown below the editor after a draft errors. A rose tint
// callout with an alert glyph + Try again / Dismiss. Whatever text streamed in
// before the failure is kept in the editor (the hook never clears it on error).
export function DraftErrorNotice({ onRetry, onDismiss }: DraftErrorNoticeProps) {
  const t = useTranslations('draftWithAi');
  return (
    <Card tint="rose" className="flex items-start gap-2.5 p-3" role="alert">
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-(--el-danger-text)" aria-hidden />
      <div className="flex flex-col gap-1.5">
        <span className="text-(--el-text-strong) text-sm font-medium">{t('errorTitle')}</span>
        <span className="text-(--el-text-strong) text-xs">{t('errorBody')}</span>
        <div className="mt-1 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
            onClick={onRetry}
          >
            {t('tryAgain')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            {t('dismiss')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// The "AI-drafted" source pill (3C) — info severity + Sparkles. Shown while the
// editor holds an untouched AI draft (or a persisted ai_draft). The edit form
// already renders its own via labelAccessory; the create modal uses this in the
// disclosure header.
export function AiDraftedPill() {
  const t = useTranslations('draftWithAi');
  return (
    <Pill severity="info">
      <span className="inline-flex items-center gap-1">
        <Sparkles className="h-3 w-3" aria-hidden />
        {t('aiDrafted')}
      </span>
    </Pill>
  );
}
