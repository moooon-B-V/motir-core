'use client';

import { useTranslations } from 'next-intl';
import { SignalHigh, SignalLow, SignalMedium, X } from 'lucide-react';
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
  low: SignalLow,
  medium: SignalMedium,
  high: SignalHigh,
};

export function DifficultyIndicator({ difficulty }: { difficulty: WorkItemDifficultyDto }) {
  const tl = useTranslations('labels');
  const Glyph = DIFFICULTY_GLYPH[difficulty];
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
  const options: SegmentedOption<WorkItemDifficultyDto>[] = WORK_ITEM_DIFFICULTIES.map((d) => {
    const Glyph = DIFFICULTY_GLYPH[d];
    return {
      value: d,
      label: tl(`difficulty.${d}`),
      icon: <Glyph className="h-3.5 w-3.5" aria-hidden />,
    };
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
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
