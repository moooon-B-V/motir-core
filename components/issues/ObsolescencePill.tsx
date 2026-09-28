'use client';

import { Ban, History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';

// THE OBSOLESCENCE PILL (Story MOTIR-6577 · MOTIR-6632; design
// `design/ai-planning/design-notes.md` Part XXIV §24.5) — the product's ONE
// rendering of a card's mark. The plan review draws it first (a `modify` card's
// top row, the peek's Mark row); MOTIR-6575's item page, quick view, list and
// board compose it rather than invent a second.
//
// A named composition of the design system's `Pill`, no container of its own:
//   · `outdated`   → `tone="neutral"`  + lucide `History`
//   · `deprecated` → `tone="archived"` + lucide `Ban`
// No hue, deliberately: the mark always sits beside a FINISHED status pill, and
// status owns the hue; the word and a distinct glyph carry the difference. The
// label is the item page's own (`labels.obsolescence.*`).

const MARK_GLYPH = { outdated: History, deprecated: Ban } as const;
const MARK_TONE = { outdated: 'neutral', deprecated: 'archived' } as const;

/**
 * Node size matches the canvas card's status pill (Part XXIV §24.5); row size is
 * `Pill` as shipped.
 */
const NODE_SIZE = 'shrink-0 px-1.5 py-0.5 text-[11px]';

export function ObsolescencePill({
  mark,
  size = 'row',
  srPrefix,
  className,
  testId,
}: {
  mark: WorkItemObsolescenceDto;
  /** `row` is `Pill` as shipped; `node` is the canvas card's 11px pill. */
  size?: 'row' | 'node';
  /** A visually hidden word read before the mark — the plan card's
   *  `Proposed mark` (§24.15: announced *Proposed mark Outdated*). */
  srPrefix?: string;
  className?: string;
  /** A stable hook for tests (the plan card's `plan-item-obsolescence`). */
  testId?: string;
}) {
  const tl = useTranslations('labels');
  const Glyph = MARK_GLYPH[mark];
  return (
    <Pill
      tone={MARK_TONE[mark]}
      data-obsolescence={mark}
      data-testid={testId}
      className={[size === 'node' ? NODE_SIZE : 'shrink-0', className].filter(Boolean).join(' ')}
    >
      {srPrefix ? <span className="sr-only">{`${srPrefix} `}</span> : null}
      <Glyph className="h-3 w-3" aria-hidden />
      {tl(`obsolescence.${mark}`)}
    </Pill>
  );
}
