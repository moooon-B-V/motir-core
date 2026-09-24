'use client';

import { useTranslations } from 'next-intl';
import { Signal, SignalHigh, SignalLow, SignalMedium, X } from 'lucide-react';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';

// A leaf's DIFFICULTY — the read-mode indicator and the editor (Story MOTIR-6016 ·
// MOTIR-6101), per design/work-items/core-fields--difficulty.mock.html. The value
// is a plain label with a FAINT signal glyph and never a pill or a hue: Priority
// shares the words Medium / High and owns a coloured pill, so a coloured
// difficulty would read as a second priority. The editor is the same `Segmented`
// the Executor field uses, with a separate Clear — the Segmented has no empty
// member, so clearing is its own deliberate press.

const DIFFICULTY_GLYPH: Record<WorkItemDifficultyDto, typeof SignalLow> = {
  trivial: SignalLow,
  low: SignalMedium,
  medium: SignalHigh,
  high: Signal,
};

export function DifficultyIndicator({
  difficulty,
  compact,
}: {
  difficulty: WorkItemDifficultyDto;
  /**
   * The COMPACT form the plan review draws (story MOTIR-6095 · MOTIR-6137,
   * `design/ai-planning/design-notes.md` Part XX §20.3 / §20.7): an INLINE value
   * at the card's 12px glyph size, inheriting the host's text size and ink, and
   * NAMED for a screen reader by a visually hidden `srLabel` (so it is announced
   * as "Difficulty Medium", never a bare "Medium", which Priority also says). The
   * same glyph map and label as the item page — never a second map.
   */
  compact?: { srLabel: string; className?: string; testId?: string };
}) {
  const tl = useTranslations('labels');
  const Glyph = DIFFICULTY_GLYPH[difficulty];
  if (compact) {
    return (
      <span
        className={`inline-flex shrink-0 items-center gap-1 ${compact.className ?? ''}`.trim()}
        data-difficulty={difficulty}
        data-testid={compact.testId}
      >
        <span className="sr-only">{`${compact.srLabel} `}</span>
        <Glyph className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
        {tl(`difficulty.${difficulty}`)}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5" data-difficulty={difficulty}>
      <Glyph className="h-4 w-4 text-(--el-text-faint)" aria-hidden />
      {tl(`difficulty.${difficulty}`)}
    </span>
  );
}

export interface DifficultyPickerProps {
  /** `null` = unset: no segment is pressed. */
  value: WorkItemDifficultyDto | null;
  /** A value to set, or `null` to clear. */
  onChange: (value: WorkItemDifficultyDto | null) => void;
  disabled?: boolean;
}

export function DifficultyPicker({ value, onChange, disabled }: DifficultyPickerProps) {
  const tl = useTranslations('labels');
  const tu = useTranslations('ui');
  // NO leading glyph in the EDITOR (MOTIR-6200, for MOTIR-6199). Every option is
  // on screen at once here, so the glyph discriminates nothing a label does not —
  // and it cost 20px a segment in a rail that had none to give. Read mode is the
  // opposite case and KEEPS its glyph: a lone "Medium" has to say difficulty
  // rather than priority (the note at the top of this file).
  const options: SegmentedOption<WorkItemDifficultyDto>[] = WORK_ITEM_DIFFICULTIES.map((d) => ({
    value: d,
    label: tl(`difficulty.${d}`),
  }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        // FILL the rail rather than size to the options: this control lives in a
        // FIXED 18rem item-page rail and a 300px quick-view rail, so a
        // content-sized track overran both as soon as the scale gained a fourth
        // member. Filling makes the width the rail's at any style and any level.
        fill
        options={options}
        // An unset value presses nothing: `Segmented` compares by identity.
        value={(value ?? '') as WorkItemDifficultyDto}
        onChange={onChange}
        label={tu('difficultyPicker.label')}
        disabled={disabled}
      />
      {value !== null ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-[13px] text-(--el-text-muted) hover:text-(--el-text) disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          {tu('difficultyPicker.clear')}
        </button>
      ) : null}
    </div>
  );
}
