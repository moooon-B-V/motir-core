'use client';

import { type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { type PlanningLaunchContext } from '@/lib/planning/launcher';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';

/**
 * PlanWithAILauncher — the ONE reusable hero affordance that summons the AI
 * planning workspace (MOTIR-1299 / Story 7.20; design @
 * `design/ai-chat/planning-workspace.mock.html` sheet 4, "A — the header
 * 'Plan with AI' pill"). Because the global header + ⌘K are on every screen,
 * this single entrance is summonable from anywhere — no per-surface button.
 *
 * It is a HERO control, not a plain Button: a palette-derived gradient fill
 * (`--el-accent` → an `--el-highlight`-leaning violet, accent-dominant so the
 * white `--el-accent-text` stays AA), an outer pink+violet glow (the pink lives
 * ONLY in the glow), a `Sparkles` mark, and a shimmer sweep (gated behind
 * `prefers-reduced-motion`). Every colour is `color-mix()` over `--el-*`, never
 * a raw hex, and its radius/height/padding flow through shape tokens — so it
 * re-skins with `data-palette` and re-shapes with `data-style` like the rest of
 * the UI.
 *
 * `context` is the originating surface; `useOpenPlanningWorkspace` resolves it
 * to the mode and to the OVERLAY address on the page this pill sits on
 * (MOTIR-4730) — a plain click opens the workspace in place with `shallowPush`,
 * and the page underneath never unmounts. Still a real `<Link>` carrying that
 * full address, so it is keyboard-reachable and middle/⌘-clickable: those open
 * the same page with the workspace over it, which is the cold deep link. The detail door (MOTIR-910) and the
 * roadmap toggle (MOTIR-1011) reuse this component with their own context.
 *
 * Gating is the MOUNT's job (the launcher renders only where AI planning is
 * configured + there's a project to plan into) — the `--el-*`/`server-only`
 * config read can't cross into this client component, so the shell passes the
 * boolean and conditionally renders this.
 */
export interface PlanWithAILauncherProps {
  /** The surface the launcher is invoked from — resolved to the planning mode. */
  context: PlanningLaunchContext;
  /**
   * WHERE the pill renders, which decides its two responsive gates
   * (MOTIR-2373 · design/shell design-notes.md § *Every control's disposition
   * below `md`*).
   *
   * - `'page'` (default) — a page-level CTA (/plans, /roadmap, code-health).
   *   Always laid out; label from `sm`. Unchanged.
   * - `'bar'` — the top nav's right cluster. The pill is DROPPED below `md`
   *   (`hidden md:inline-flex`) and its label waits for `lg`. It is the one
   *   control that can leave the bar and cost nothing, which is why it leaves
   *   first: `PlanWithAIFab` — the floating orb — already ships on every authed
   *   screen behind the SAME `showPlanWithAi` gate, and ⌘K carries a
   *   `plan-with-ai` action. Two doors already exist at 375px.
   */
  placement?: 'bar' | 'page';
  className?: string;
}

// Accent-dominant gradient + the outer aura. White (the accent's ink) sheens the
// top edge; the pink (`--el-highlight`) lives only in the outer glow. All
// palette-derived (the surface-material colour grammar — color-mix over --el-*).
//
// ⚠️ BOTH DECLARATIONS READ FROM A VARIABLE, and the literals below are their
// FALLBACKS — not indirection for its own sake (MOTIR-3522 for the shadow,
// MOTIR-4743 for the fill). An INLINE declaration beats every stylesheet rule,
// so while this pill painted its own shadow directly no [data-style] block could
// give it depth: under `3d-immersive` it was the one control on the page that
// stayed flat no matter how the style layer was widened. The same was true of
// the FILL under all eleven styles — `design/ai-chat/design-notes.md`
// § *The STYLE MATRIX* draws a per-style treatment for this control and the
// stylesheet had no way to reach it. The variables are the seam that lets a
// style re-point them: `--plan-hero-shadow` is set by the `3d-immersive` block
// and `--plan-hero-fill` by the per-style hero rules, both in
// packages/design-system/theme.css. Every style that sets neither falls through
// to these literals, unchanged.
//
// ⚠️ THE FAR STOP IS 86%, NOT 55% (MOTIR-4742 finding A). The label spans the
// whole pill, so it also sits on the far stop — which at 55% is 45% brand pink
// and measured 4.64:1 light / **3.98:1 dark**, below the 4.5:1 bar, on the
// product's headline control. It also contradicted this file's own design note
// (*"the brand pink lives only in the glow/aura, never under text"*). At 86% the
// fill is accent-dominant and measures 5.97:1 / 4.64:1; 80% is the first passing
// value, and 86% is specified so the bar is cleared with margin rather than met.
// Ten of the eleven styles inherit this stop, so it is not optional for any of
// them.
const HERO_STYLE: CSSProperties = {
  backgroundImage:
    'var(--plan-hero-fill, linear-gradient(135deg, var(--el-accent), color-mix(in srgb, var(--el-accent) 86%, var(--el-highlight))))',
  boxShadow: [
    'var(--plan-hero-shadow,',
    'inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) 38%, transparent),',
    'inset 0 0 0 1px color-mix(in srgb, var(--el-accent-text) 18%, transparent),',
    '0 6px 18px -5px color-mix(in srgb, var(--el-accent) 75%, transparent),',
    '0 0 22px -3px color-mix(in srgb, var(--el-highlight) 50%, transparent))',
  ].join(' '),
};

export function PlanWithAILauncher({
  context,
  placement = 'page',
  className,
}: PlanWithAILauncherProps) {
  const t = useTranslations('shell');
  const label = t('planWithAI.label');
  const inBar = placement === 'bar';
  const { href, open } = useOpenPlanningWorkspace(context);

  return (
    <Link
      href={href}
      onClick={open}
      aria-label={label}
      // The plane this control sits on (MOTIR-3522). A pill on the badge radius
      // is a flat chip by default — correct for the 9 filter/tag chips that
      // share the radius, wrong for this one, which is a hero ACTION.
      data-depth="key"
      // The MATERIAL hook (MOTIR-4743), the axis `data-depth` does not carry.
      // `data-surface` is what every per-style material rule selects on; the
      // second attribute is load-bearing rather than a convenience, because the
      // pill and the orb do NOT share a fill recipe — the orb's first stop is
      // `--orb-lit-mix`, a guarded contrast knob (MOTIR-3207), and a rule
      // written against `[data-surface='ai-cta']` alone would set one
      // `background-image` over both and silently overwrite it. So shared
      // properties (border, glow, type, ink) are written on `data-surface` and
      // every fill under `data-ai-cta`.
      data-surface="ai-cta"
      data-ai-cta="pill"
      style={HERO_STYLE}
      className={cn(
        // Layout + pill shape (radius/height/padding via shape tokens so the
        // pill reshapes with the active style).
        'group relative h-(--height-btn-md) items-center gap-2 overflow-hidden rounded-(--radius-badge) px-(--spacing-btn-x)',
        // Selected, not appended — `.hidden` and `.inline-flex` have equal
        // specificity, so appending would leave the winner to emission order.
        inBar ? 'hidden md:inline-flex' : 'inline-flex',
        // Typography — white ink on the accent-dominant fill.
        'font-sans text-sm font-semibold whitespace-nowrap text-(--el-accent-text)',
        // Interaction parity with the Button primitive.
        'transition-transform active:scale-(--active-scale)',
        'focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        className,
      )}
    >
      {/* The shimmer sweep — a clipped light band that crosses the pill. Inert
          (no animation) under prefers-reduced-motion; the class only adds the
          motion (globals.css). */}
      <span
        aria-hidden
        className="plan-with-ai-shimmer pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 -skew-x-12"
        style={{
          backgroundImage:
            'linear-gradient(100deg, transparent, color-mix(in srgb, var(--el-accent-text) 55%, transparent), transparent)',
        }}
      />
      <Sparkles
        className="relative h-4 w-4 shrink-0"
        aria-hidden
        style={{
          filter: 'drop-shadow(0 0 5px color-mix(in srgb, var(--el-accent-text) 80%, transparent))',
        }}
      />
      <span className={cn('relative hidden', inBar ? 'lg:inline' : 'sm:inline')}>{label}</span>
    </Link>
  );
}
