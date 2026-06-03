'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Ban } from 'lucide-react';

// ColorSwatchPicker — a keyboard-navigable radiogroup of curated status colors
// (Story 2.2 · Subtask 2.2.8). Replaces the free-text hex input in the workflow
// status form. The palette is drawn from the design-system semantic tokens
// (globals.css) and stored as HEX — theme-independent and durable (a status's
// color shouldn't shift if a CSS var is renamed). `null` = "derive from
// category" (the Pill/category tint decides the swatch).
//
// A11y: WAI-ARIA radiogroup pattern — role="radiogroup" + role="radio"
// children, `aria-checked`, roving tabindex (only the selected swatch is in the
// tab order), arrow keys move + select, and a high-contrast focus/selected ring
// that's independent of the swatch fill (so it reads on any color, AA-safe).

export interface ColorSwatchOption {
  /** Accessible name + tooltip. */
  name: string;
  /** The stored hex value, or null for "derive from category". */
  value: string | null;
}

export const STATUS_COLOR_SWATCHES: ReadonlyArray<ColorSwatchOption> = [
  { name: 'None (derive from category)', value: null },
  { name: 'Grey', value: '#787671' },
  { name: 'Blue', value: '#0075de' },
  { name: 'Teal', value: '#2a9d99' },
  { name: 'Green', value: '#1aae39' },
  { name: 'Orange', value: '#dd5b00' },
  { name: 'Red', value: '#e03131' },
  { name: 'Pink', value: '#ff64c8' },
];

export interface ColorSwatchPickerProps {
  /** Selected hex, or null for "derive from category". */
  value: string | null;
  onChange: (value: string | null) => void;
  label?: string;
  disabled?: boolean;
}

export function ColorSwatchPicker({
  value,
  onChange,
  label = 'Color',
  disabled,
}: ColorSwatchPickerProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = STATUS_COLOR_SWATCHES.findIndex((s) => s.value === value);
  // Roving tabindex anchor: the selected swatch, or the first when nothing matches
  // (e.g. a legacy custom hex outside the curated palette).
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function select(index: number) {
    const opt = STATUS_COLOR_SWATCHES[index];
    if (!opt) return;
    onChange(opt.value);
    refs.current[index]?.focus();
  }

  function onKeyDown(e: KeyboardEvent, index: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      select((index + 1) % STATUS_COLOR_SWATCHES.length);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      select((index - 1 + STATUS_COLOR_SWATCHES.length) % STATUS_COLOR_SWATCHES.length);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground font-sans text-sm font-medium">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {STATUS_COLOR_SWATCHES.map((opt, i) => {
          const checked = opt.value === value;
          return (
            <button
              key={opt.name}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={opt.name}
              title={opt.name}
              tabIndex={i === tabbableIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`flex h-7 w-7 items-center justify-center rounded-full border border-border transition-shadow focus-visible:ring-foreground focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50 ${
                checked ? 'ring-foreground ring-2 ring-offset-2' : ''
              }`}
              style={opt.value ? { backgroundColor: opt.value } : undefined}
            >
              {opt.value === null && <Ban className="text-muted-foreground h-4 w-4" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
