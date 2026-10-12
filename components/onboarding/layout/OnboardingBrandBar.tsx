import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand/BrandMark';

// The page-shaped onboarding screens' brand bar (MOTIR-8252) — Pattern A of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (MOTIR-8250, design-notes.md § "2026-10-11 — the vibe layout", the "Lockup"
// and "Lockup bar" rows). It replaces the lavender `Sparkles` tile + bare
// "Motir" text the entrance drew inline: the real Motir lockup, linked home.
//
//   - `BrandMark variant="lockup" tone="default" size={28}` — glyph
//     `--el-accent-on-surface`, wordmark `--el-text` (the `.brand-*` block).
//   - The link carries NO `aria-label`: the glyph is `aria-hidden` and the
//     visible wordmark names the link (design/brand §8, "never both").
//   - NO fill and NO rule — the bar sits on whatever ground it is placed on
//     (the hero's `--el-surface` inside `OnboardingHero`, the page ground on a
//     screen that has no hero yet). The design is explicit about this; it is
//     motir.co's `SiteHeader`.
//   - `px-(--spacing-card-padding) py-4`, and `px-4 py-3` narrow.
//
// `children` is the trailing slot (`justify-between`: lockup start, slot end)
// — the language control (MOTIR-8286, design Revision 2) or a screen control
// such as the migrate card's "Start from an idea instead". Presentational: it
// takes nodes, calls no `useTranslations`, and owns no copy.

export interface OnboardingBrandBarProps {
  /** The trailing control(s), opposite the lockup. Omitted renders the lockup alone. */
  children?: ReactNode;
  className?: string;
}

export function OnboardingBrandBar({ children, className }: OnboardingBrandBarProps) {
  return (
    <header
      data-onboarding-brand-bar=""
      className={[
        'flex items-center justify-between gap-4 px-4 py-3 md:px-(--spacing-card-padding) md:py-4',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Link
        href="/"
        className="inline-flex items-center rounded-(--radius-control) no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
      >
        <BrandMark variant="lockup" tone="default" size={28} />
      </Link>
      {children}
    </header>
  );
}
