'use client';

import { FileText, MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils/cn';
import type { PlanRowDestination } from '@/lib/planning/planDestination';

// THE DESTINATION TAG (Story MOTIR-6043 · MOTIR-6045; design
// `design/ai-planning/design-notes.md` Part XXI §21.2) — the row SAYS where it
// goes, before it is clicked.
//
// ONE element, TWO hosts: the Plans page's session row (the last item of its
// meta line) and the workbench's To-approve row (the first column, after the key
// cell). It is the visible half of the one destination rule
// (`lib/planning/planDestination.ts`), so a reader can see the two lists agree
// rather than having to click both.
//
// ⚠️ INK ONLY, AND INERT, both deliberately.
//
//   · No tint, no border, no surface, no token of its own: it inherits
//     `--el-text-secondary` from the line it sits on and the glyph inherits
//     `currentColor`. Both rows ALREADY carry a coloured chip meaning the plan's
//     STATE, and a second coloured mark meaning its DESTINATION would compete
//     with the first and read as a second status. It is also why the dark board
//     needs no rule of its own.
//   · No focus, no hover state, not in the tab order. The row's own door is the
//     control; this only says where that door goes. A second focusable element
//     per row for a thing you cannot press is noise on a list.
//
// ⚠️ GLYPH *AND* WORDS, never a glyph alone. The two destinations are a
// conversation and a document, which is exactly the distinction one small mark
// is worst at carrying — PRODECT_FINDINGS #35's rule (never rest a state on a
// mark alone) applies to a destination as much as to a status. The two glyphs
// are ones a reader has already met on these surfaces: `messages-square` is the
// session list's own `conversation`-origin square, and `file-text` is the plan's
// document mark.

export function PlanDestinationTag({
  destination,
  className,
}: {
  destination: PlanRowDestination;
  /** Host-specific flex behaviour only — `shrink-0` where the line wraps, `shrink` where it truncates. */
  className?: string;
}) {
  const t = useTranslations('planDestination');
  const conversation = destination.kind === 'planning-surface';
  // A page reached for want of a conversation says so; a DECIDED one does not,
  // because "no conversation" would be false of it and beside the point anyway.
  const why = destination.kind === 'plan-page' && destination.reason === 'no-conversation';
  const Glyph = conversation ? MessagesSquare : FileText;

  return (
    <span
      data-testid="plan-destination"
      data-destination={destination.kind}
      className={cn('inline-flex min-w-0 items-center gap-1', className)}
      title={why ? t('noConversationWhy') : undefined}
    >
      <Glyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{conversation ? t('conversation') : t('plan')}</span>
      {why ? (
        <>
          {/* The shipped `·` idiom, copied from the session row's own starter line. */}
          <span className="shrink-0 text-(--el-text-faint)" aria-hidden>
            ·
          </span>
          <span className="truncate">{t('noConversation')}</span>
        </>
      ) : null}
    </span>
  );
}
