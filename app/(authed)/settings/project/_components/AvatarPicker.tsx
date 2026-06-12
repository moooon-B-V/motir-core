'use client';

import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import {
  AVATAR_COLORS,
  AVATAR_ICONS,
  type AvatarColor,
  type AvatarIcon,
} from '@/lib/projects/avatar';
import { cn } from '@/lib/utils/cn';
import { ProjectAvatar } from '../../../_components/ProjectAvatar';

// The avatar picker (Story 6.8 · Subtask 6.8.4) — a Popover holding the 18
// preset icons + 6 colour swatches + a live preview + "None", per
// `design/projects/details.mock.html` panel 2. The picker renders from the SAME
// two key sets the 6.8.1 `updateDetails` service validates against (imported
// from `lib/projects/avatar.ts`); the chip's key → lucide map lives in
// ProjectAvatar (the UI-free split). Colour swatches are `--el-tint-*` (the
// swap layer), never a raw `--color-*`.
//
// a11y: the icon grid is a `radiogroup` (arrow-key roving, the selected option
// tabbable); the swatches are a second `radiogroup`. "None" clears both keys
// (the mono fallback). Selection is fully controlled by the parent.

// Literal swatch backgrounds — kept as a static map so Tailwind's scanner emits
// each `--el-tint-*` utility (interpolated class names are not scanned).
const SWATCH_BG: Record<AvatarColor, string> = {
  peach: 'bg-(--el-tint-peach)',
  rose: 'bg-(--el-tint-rose)',
  mint: 'bg-(--el-tint-mint)',
  lavender: 'bg-(--el-tint-lavender)',
  sky: 'bg-(--el-tint-sky)',
  yellow: 'bg-(--el-tint-yellow)',
};

export interface AvatarPickerProps {
  icon: string | null;
  color: string | null;
  identifier: string;
  disabled?: boolean;
  onChange: (next: { icon: string | null; color: string | null }) => void;
}

export function AvatarPicker({ icon, color, identifier, disabled, onChange }: AvatarPickerProps) {
  const t = useTranslations('settings.details');
  const [open, setOpen] = useState(false);

  // Picking an icon when no colour is set (or vice versa) seeds the other half
  // with a sensible default so the chip always has both — null/null is reserved
  // for the explicit "None".
  function pickIcon(next: AvatarIcon) {
    onChange({ icon: next, color: (color as AvatarColor | null) ?? AVATAR_COLORS[3] });
  }
  function pickColor(next: AvatarColor) {
    onChange({ icon: (icon as AvatarIcon | null) ?? AVATAR_ICONS[0], color: next });
  }
  function clear() {
    onChange({ icon: null, color: null });
  }

  return (
    <div className="flex items-center gap-3">
      <ProjectAvatar icon={icon} color={color} identifier={identifier} size={52} />
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Pencil className="h-4 w-4" />}
            disabled={disabled}
          >
            {t('changeAvatar')}
          </Button>
        </Popover.Trigger>
        <Popover.Content align="start" width={264} className="p-3">
          <RadioGrid
            label={t('pickerIcon')}
            options={AVATAR_ICONS}
            selected={icon}
            columns={6}
            onSelect={pickIcon}
            renderOption={(key) => (
              <ProjectAvatar
                icon={key}
                color={(color as AvatarColor | null) ?? AVATAR_COLORS[3]}
                identifier={identifier}
                size={26}
              />
            )}
          />
          <RadioGrid
            label={t('pickerColour')}
            options={AVATAR_COLORS}
            selected={color}
            columns={6}
            onSelect={pickColor}
            className="mt-3"
            renderOption={(key) => (
              <span className={cn('h-6 w-6 rounded-full', SWATCH_BG[key])} aria-hidden />
            )}
          />
          <div className="mt-3 flex items-center justify-between border-t border-(--el-border-soft) pt-3">
            <span className="flex items-center gap-2 font-sans text-xs text-(--el-text-muted)">
              {t('pickerPreview')}
              <ProjectAvatar icon={icon} color={color} identifier={identifier} size={24} />
            </span>
            <button
              type="button"
              onClick={clear}
              className="rounded-(--radius-control) px-2 py-1 font-sans text-xs font-medium text-(--el-link) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              {t('pickerNone')}
            </button>
          </div>
        </Popover.Content>
      </Popover>
    </div>
  );
}

// A labelled radiogroup of square option tiles with arrow-key roving focus.
function RadioGrid<T extends string>({
  label,
  options,
  selected,
  columns,
  onSelect,
  renderOption,
  className,
}: {
  label: string;
  options: readonly T[];
  selected: string | null;
  columns: number;
  onSelect: (value: T) => void;
  renderOption: (value: T) => ReactNode;
  className?: string;
}) {
  const labelId = useId();
  // The tabbable option is the selected one, or the first when none is selected
  // (the standard radiogroup roving-tabindex rule).
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o === selected),
  );

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      nextIndex = (index - 1 + options.length) % options.length;
    if (nextIndex === null) return;
    const nextValue = options[nextIndex];
    if (nextValue === undefined) return;
    e.preventDefault();
    onSelect(nextValue);
    const grid = e.currentTarget.parentElement;
    grid?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  }

  return (
    <div role="radiogroup" aria-labelledby={labelId} className={className}>
      <span
        id={labelId}
        className="mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-wide text-(--el-text-muted)"
      >
        {label}
      </span>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map((value, index) => {
          const isSelected = value === selected;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={value}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => onSelect(value)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={cn(
                'flex aspect-square items-center justify-center rounded-(--radius-control) transition-colors',
                'hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
                isSelected && 'ring-2 ring-(--el-accent)',
              )}
            >
              {renderOption(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
