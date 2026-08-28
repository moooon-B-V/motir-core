import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

// The inline notice the account-settings assets share (`.callout` in
// `design/settings/account-settings.mock.html`, and identically in
// `account-data.mock.html`): a tinted box, a semantic glyph, and one paragraph
// of `--el-text-strong` on the tint.
//
// ONE definition, used by the Data & privacy pane, its export card and its
// deletion card — three surfaces that draw the same shape and would otherwise
// each carry their own copy of the tint/ink pairing. That pairing is the reason
// it is worth extracting: the hue lives in the BACKGROUND and the ink is
// `--el-text-strong`, which is what makes it clear AA in both themes (finding
// #35). A fourth hand-rolled copy is a fourth chance to put the hue in the text.
//
// No `'use client'`: it holds no state, so it renders on the server AND composes
// into a client island unchanged.

const TONES = {
  info: { box: 'bg-(--el-tint-sky)', ink: 'text-(--el-info)' },
  warn: { box: 'bg-(--el-tint-peach)', ink: 'text-(--el-warning)' },
} as const;

export interface SettingsCalloutProps {
  tone?: keyof typeof TONES;
  /** Overrides the default info glyph. Rendered `aria-hidden` by its caller. */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SettingsCallout({
  tone = 'info',
  icon,
  className,
  children,
}: SettingsCalloutProps) {
  const tokens = TONES[tone];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-(--radius-card) p-3.5 ${tokens.box} ${
        className ?? ''
      }`}
    >
      <span className={`mt-px inline-flex h-[18px] w-[18px] shrink-0 ${tokens.ink}`}>
        {icon ?? <Info aria-hidden className="h-[18px] w-[18px]" />}
      </span>
      <p className="m-0 font-sans text-sm leading-relaxed text-(--el-text-strong)">{children}</p>
    </div>
  );
}
