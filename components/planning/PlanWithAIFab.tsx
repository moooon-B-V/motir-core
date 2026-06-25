'use client';

import { type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { planningWorkspaceHref, type PlanningLaunchContext } from '@/lib/planning/launcher';

/**
 * PlanWithAIFab — the floating "M" entrance to the AI planning workspace
 * (MOTIR-1299 / Story 7.20; design @ `design/ai-chat/planning-workspace.mock.html`
 * sheet 4, "B — the floating 'M' button"). A glowing orb afloat bottom-right on
 * every screen — the second of the two entrances the design ships (alongside the
 * header pill, `PlanWithAILauncher`).
 *
 * Scope (Yue, 2026-06-24): the orb opens the planning workspace DIRECTLY — the
 * broader "universal AI callout" the design sketches for it (a menu where
 * planning sits alongside project Q&A + task help) is deferred to its own story,
 * since those backends don't exist yet. When that lands, this orb grows a menu
 * in place; today a click goes straight to planning.
 *
 * Built with a MOCK "M" logo (the real brand mark lands later, per the design).
 * Palette-derived throughout (the orb fill + glow are `color-mix()` over `--el-*`,
 * never raw hex); the orb is genuinely circular (`rounded-full`). A real `<Link>`
 * so it's keyboard-reachable + middle/⌘-clickable. Sits at `z-40` — below toasts
 * / modals / the command palette (`z-50`), which may transiently cover it.
 *
 * Gating is the MOUNT's job (rendered only where AI planning is configured +
 * there's a project to plan into), like the header pill.
 */
export interface PlanWithAIFabProps {
  /** The originating context — defaults to the global project entrance. */
  context?: PlanningLaunchContext;
  className?: string;
}

// The orb fill (a lit sphere — lighter top-left, accent body, a violet-leaning
// edge) + the pink+violet aura. All palette-derived.
const ORB_STYLE: CSSProperties = {
  backgroundImage:
    'radial-gradient(circle at 33% 27%, color-mix(in srgb, var(--el-accent-text) 32%, var(--el-accent)), var(--el-accent) 56%, color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight)))',
  boxShadow: [
    'inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) 40%, transparent)',
    '0 8px 24px -6px color-mix(in srgb, var(--el-accent) 80%, transparent)',
    '0 0 28px -2px color-mix(in srgb, var(--el-highlight) 55%, transparent)',
  ].join(', '),
};

export function PlanWithAIFab({ context = { kind: 'project' }, className }: PlanWithAIFabProps) {
  const t = useTranslations('shell');
  const label = t('planWithAI.label');

  return (
    <Link
      href={planningWorkspaceHref(context)}
      aria-label={label}
      title={label}
      style={ORB_STYLE}
      className={cn(
        'fixed right-5 bottom-5 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full',
        'text-(--el-accent-text) select-none',
        'transition-transform hover:scale-105 active:scale-95',
        'focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        className,
      )}
    >
      {/* The gently-pulsing aura ring (gated behind prefers-reduced-motion in
          globals.css) so the orb reads as "glowing" — inert for motion-sensitive
          users. */}
      <span
        aria-hidden
        className="plan-with-ai-fab-pulse pointer-events-none absolute inset-0 rounded-full"
        style={{ boxShadow: '0 0 0 0 color-mix(in srgb, var(--el-highlight) 60%, transparent)' }}
      />
      {/* Mock "M" brand mark — replaced by the real logo later (design note). */}
      <span aria-hidden className="relative font-sans text-xl leading-none font-bold">
        M
      </span>
    </Link>
  );
}
