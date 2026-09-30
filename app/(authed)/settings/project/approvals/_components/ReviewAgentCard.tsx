'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Info, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import type { PrMergeModeValue } from '@/lib/dto/projects';

// The REVIEW-AGENT switch (Story MOTIR-1626 · Subtask MOTIR-6823), built to
// `design/projects/approvals--review-agent.mock.html` (MOTIR-6816) panels 1–6 and
// `design-notes.md` § "Approvals — the Review agent switch". Composed exactly as
// `AcceptanceVideoGateCard` (optimistic switch, put back on failure, the room's
// toasts), with the `Bot` glyph in the title the way `PrMergeModeCard` carries
// `GitMerge`. A pure client consumer of `PATCH /api/projects/[key]/approval-gates`
// (`{ reviewAgentEnabled }`).
//
// ⚠️ THE EXCLUSION (`docs/decisions/approval-gates.md` §12.2a · panel 2a). A review
// stands in front of a person's approval, and a project that merges automatically
// asks nobody — so in an `auto` project the card reads UNAVAILABLE and its switch
// is off and disabled, whatever the stored flag says. The name and the switch read
// ONE derived `state`, so they cannot disagree. The server refuses the same write
// (409 `REVIEW_AGENT_NEEDS_MANUAL_MERGE`), which a stale page meets as the refused
// state. `prMergeMode` is the page's CURRENT value, lifted by
// `MergeModeAndReviewAgentCards`, so choosing a mode above re-renders this card.
//
// ⚠️ INK. Title and state name `--el-text`; description, gloss and footer lines
// `--el-text-secondary` — never `--el-text-muted` (fails AA on these surfaces).
//
// NO read-only state: the room is manage-only (design notes § ⭐ Approvals §6),
// so whoever renders this card may change it — as its two siblings.

export const REVIEW_AGENT_ANCHOR = 'review-agent';

export interface ReviewAgentCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialEnabled: boolean;
  /** The project's CURRENT merge mode on this page — `auto` makes the switch unavailable. */
  prMergeMode: PrMergeModeValue;
  /** Told every value the switch shows (optimistic, reconciled, put back). */
  onEnabledChange?: (enabled: boolean) => void;
}

type ReviewAgentState = 'on' | 'off' | 'unavailable';

export function ReviewAgentCard({
  projectKey,
  initialEnabled,
  prMergeMode,
  onEnabledChange,
}: ReviewAgentCardProps) {
  const t = useTranslations('approvals.reviewAgent');
  const { toast } = useToast();
  const [enabled, setEnabledState] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();
  const state: ReviewAgentState = prMergeMode === 'auto' ? 'unavailable' : enabled ? 'on' : 'off';
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

  function setEnabled(next: boolean) {
    setEnabledState(next);
    onEnabledChange?.(next);
  }

  function toggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/approval-gates`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewAgentEnabled: next }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
        const settings = (await res.json()) as { reviewAgentEnabled: boolean };
        setEnabled(settings.reviewAgentEnabled);
        toast({ variant: 'success', title: t('saved') });
      } catch {
        setEnabled(previous);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  return (
    <Card
      // The Development frame's settings door (MOTIR-6817) lands here, as
      // `#merge-mode` and `#acceptance-video` are landed on.
      id={REVIEW_AGENT_ANCHOR}
      className="scroll-mt-6"
      header={
        <div>
          <h2 className="flex items-center gap-2 font-sans text-base font-semibold text-(--el-text)">
            <Bot className="size-4" aria-hidden />
            {t('title')}
          </h2>
          <p className="text-(--el-text-secondary) font-sans text-sm">
            {t.rich('desc', { strong })}
          </p>
        </div>
      }
      footer={
        <div className="flex flex-col items-start gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('billingNote')}
          </span>
          {state === 'on' ? (
            <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
              <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('offNote')}
            </span>
          ) : null}
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="font-sans text-sm font-medium text-(--el-text)">{t(state)}</span>
          <span className="text-(--el-text-secondary) font-sans text-xs">
            {t.rich(`${state}What`, { strong })}
          </span>
        </span>
        <Switch
          checked={state === 'on'}
          onCheckedChange={toggle}
          disabled={state === 'unavailable' || isPending}
          aria-label={t('title')}
        />
      </div>
    </Card>
  );
}
