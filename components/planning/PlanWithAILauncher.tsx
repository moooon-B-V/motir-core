'use client';

import { type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { planningWorkspaceHref, type PlanningLaunchContext } from '@/lib/planning/launcher';

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
 * `context` is the originating surface; `planningWorkspaceHref` resolves it to
 * the mode + carries it to the workspace. Rendered as a real `<Link>` so it is
 * keyboard-reachable and middle/⌘-clickable. The detail door (MOTIR-910) and the
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
  className?: string;
}

// Accent-dominant gradient + the outer aura. White (the accent's ink) sheens the
// top edge; the pink (`--el-highlight`) lives only in the outer glow. All
// palette-derived (the surface-material colour grammar — color-mix over --el-*).
const HERO_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(135deg, var(--el-accent), color-mix(in srgb, var(--el-accent) 55%, var(--el-highlight)))',
  boxShadow: [
    'inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) 38%, transparent)',
    'inset 0 0 0 1px color-mix(in srgb, var(--el-accent-text) 18%, transparent)',
    '0 6px 18px -5px color-mix(in srgb, var(--el-accent) 75%, transparent)',
    '0 0 22px -3px color-mix(in srgb, var(--el-highlight) 50%, transparent)',
  ].join(', '),
};

export function PlanWithAILauncher({ context, className }: PlanWithAILauncherProps) {
  const t = useTranslations('shell');
  const label = t('planWithAI.label');

  return (
    <Link
      href={planningWorkspaceHref(context)}
      aria-label={label}
      style={HERO_STYLE}
      className={cn(
        // Layout + pill shape (radius/height/padding via shape tokens so the
        // pill reshapes with the active style).
        'group relative inline-flex h-(--height-btn-md) items-center gap-2 overflow-hidden rounded-(--radius-badge) px-(--spacing-btn-x)',
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
      <span className="relative hidden sm:inline">{label}</span>
    </Link>
  );
}
