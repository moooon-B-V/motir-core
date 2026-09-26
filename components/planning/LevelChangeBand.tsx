'use client';

import { useTranslations } from 'next-intl';
import {
  fieldLabel,
  PlanItemOpBadge,
  type PlanItemOutcome,
} from '@/components/planning/PlanItemNode';
import type { LevelChange } from '@/lib/planning/levelChange';

// THE LEVEL CHANGE BAND (bug MOTIR-6223; design MOTIR-6241,
// `design/ai-chat/planning-workspace--level-change.mock.html` sheets 3–4).
//
// The second row of the breadcrumb bar, drawn only when the plan changes the
// level the reader is standing in. The bar is already the one element on screen
// that stands for the LEVEL (MOTIR-6159's answer to MOTIR-2070), it survives at a
// 720px viewport where the canvas shows no nodes at all, and it sits directly
// under the crumb it is about — so the crumb keeps the COMMITTED title and the
// band carries the proposed one, and neither has to lie.
//
// ⚠️ ONE VOCABULARY FOR A CARD AND A LEVEL — and the card's is `PlanItemOpBadge`
// now. The design composed the band from `PlanChangeDiffFrame`'s corner tag and
// its fused outcome chip; MOTIR-6299 deleted that frame after the design was
// drawn, and every proposal is drawn by `PlanItemNode` since. The design's rule is
// that the band wears exactly what the card wears, so it composes the card's
// badge — op word, glyph, tone and the outcome fused onto it once decided — rather
// than resurrecting the retired tag.
//
// Pure presentation: the verdict (`levelChangeFor`) is decided by the caller.

const RULE: Record<LevelChange['state'], string> = {
  // `change` is the only SOLID rule because it is the only state touching a card
  // that STAYS; dashed is this surface's grammar for "proposed, not real yet".
  changed: 'border-solid border-(--el-border-soft)',
  added: 'border-dashed border-(--el-accent)',
  removed: 'border-dashed border-(--el-danger)',
};

const OP: Record<LevelChange['state'], 'add' | 'modify' | 'remove'> = {
  changed: 'modify',
  added: 'add',
  removed: 'remove',
};

export function LevelChangeBand({
  change,
  outcome,
}: {
  change: LevelChange;
  outcome: PlanItemOutcome | null;
}) {
  const t = useTranslations('planningWorkspace.arrival.levelChange');
  const tReview = useTranslations('planReview');
  return (
    <div
      data-testid="canvas-level-band"
      data-state={change.state}
      className={`mt-[5px] flex min-w-0 items-center gap-2 border-t pt-[5px] text-xs transition-opacity duration-[180ms] motion-reduce:transition-none ${RULE[change.state]}`}
    >
      {/* Never colour alone and never glyph alone — the folder crumb's
          `srPrefix` discipline, one row down. */}
      <span className="sr-only">{t('srPrefix')} </span>
      <PlanItemOpBadge op={OP[change.state]} outcome={outcome} />
      <span className="min-w-0 truncate text-(--el-text)">
        {change.state === 'changed' ? (
          <>
            {t('changed')}
            {change.proposedTitle !== null ? (
              <>
                {' — '}
                {t.rich('titleTo', {
                  title: change.proposedTitle,
                  b: (chunks) => <b className="font-semibold">{chunks}</b>,
                })}
              </>
            ) : null}
          </>
        ) : change.state === 'removed' ? (
          t('removed')
        ) : (
          t('added')
        )}
      </span>
      {change.state === 'changed' && change.fields.length > 0 ? (
        // The changed fields in the card's own words (its diff line's labels),
        // joined with `·` — the information the missing frame would have carried.
        <span
          data-testid="canvas-level-band-fields"
          className="max-w-[16rem] shrink-0 truncate rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-semibold text-(--el-text-strong)"
        >
          {change.fields.map((f) => fieldLabel(tReview, f)).join(' · ')}
        </span>
      ) : null}
    </div>
  );
}
