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
//
// The wizard screens (MOTIR-8254, design/onboarding-migrate § 2026-10-12) use
// two more slots: `lead` — the `· {flow name}` that follows the lockup — and
// `linked={false}`, which renders the lockup as a plain span, because those
// bars carry their own exits (Save & exit, Start from an idea instead) and a
// third one on the logo would compete with them. Their trailing group wraps
// under the lockup on a narrow screen instead of squeezing it.
//
// The onboarding direction-doc page (MOTIR-8255, design/ai-chat § 2026-10-12
// Panel 6) uses `inset="row"`: a slim row inside the doc's own `max-w-[60rem]`
// column — no horizontal padding of its own, `pb-4` — with the lockup at 24 px.

export interface OnboardingBrandBarProps {
  /** The trailing control(s), opposite the lockup. Omitted renders the lockup alone. */
  children?: ReactNode;
  /** Set right after the lockup — the wizard bars' `· {flow name}`. */
  lead?: ReactNode;
  /** Link the lockup home. Default `true`; the wizard bars pass `false`. */
  linked?: boolean;
  /** The lockup's size in px. Default 28 (the hero bar); the doc row passes 24. */
  size?: number;
  /** `bar` (default) pads itself; `row` sits flush inside a column the page pads. */
  inset?: 'bar' | 'row';
  className?: string;
}

export function OnboardingBrandBar({
  children,
  lead,
  linked = true,
  size = 28,
  inset = 'bar',
  className,
}: OnboardingBrandBarProps) {
  const mark = <BrandMark variant="lockup" tone="default" size={size} />;
  const lockup = linked ? (
    <Link
      href="/"
      className="inline-flex flex-none items-center rounded-(--radius-control) no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
    >
      {mark}
    </Link>
  ) : (
    <span data-brand-position="" className="inline-flex flex-none items-center">
      {mark}
    </span>
  );
  return (
    <header
      data-onboarding-brand-bar=""
      className={[
        'relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
        inset === 'row' ? 'pb-4' : 'px-4 py-3 md:px-(--spacing-card-padding) md:py-4',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {lead != null ? (
        <span className="flex min-w-0 items-center gap-3">
          {lockup}
          {lead}
        </span>
      ) : (
        lockup
      )}
      {children}
    </header>
  );
}
