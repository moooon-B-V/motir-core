'use client';

import { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { AI_CALLOUT_NAME_KEY } from '@/lib/planning/aiCallout';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import { AiCalloutMenu } from './AiCalloutMenu';

/**
 * PlanWithAIFab — the floating "M" orb, the universal AI callout's TRIGGER
 * (MOTIR-1299 / Story 7.20; MOTIR-1812 / Story 7.24. Design @
 * `design/ai-chat/ai-callout-menu.mock.html`). A glowing orb afloat
 * bottom-right on every screen — the second of the two entrances the design
 * ships (alongside the header pill, `PlanWithAILauncher`).
 *
 * It used to navigate STRAIGHT to the planning workspace; as its own note
 * promised, it has now "grown a menu in place". The orb is a `<button>` inside
 * `Popover.Trigger`, and *Plan with AI* is the first ROW of the callout
 * (`AiCalloutMenu`) — so the orb's accessible name is the callout's, "Motir
 * AI", and "Plan with AI" names the row inside. Every shipped visual is
 * unchanged: the same fill, glow, pulse, position, z-index and transitions.
 *
 * The one-click path is NOT lost — the TopNav hero pill and ⌘K still go
 * straight to `/planning` from every screen, and the rows are real links, so
 * ⌘/middle-click survives one level in.
 *
 * Built with a MOCK "M" logo (the real brand mark lands later, per the design).
 * Palette-derived throughout (the orb fill + glow are `color-mix()` over
 * `--el-*`, never raw hex); the orb is genuinely circular (`rounded-full`).
 * Sits at `z-40` — below toasts / modals / the command palette (`z-50`), which
 * may transiently cover it.
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
  const [open, setOpen] = useState(false);
  const label = t(AI_CALLOUT_NAME_KEY);

  return (
    // Non-modal, like the user menu: the page behind stays scrollable and
    // readable while the callout is open.
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <button
          type="button"
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
              users. While the callout is open the pulse STOPS (globals.css, keyed
              off the `data-state` Radix sets here) so the panel never sits inside a
              breathing halo. */}
          <span
            aria-hidden
            className="plan-with-ai-fab-pulse pointer-events-none absolute inset-0 rounded-full"
            style={{
              boxShadow: '0 0 0 0 color-mix(in srgb, var(--el-highlight) 60%, transparent)',
            }}
          />
          {/* Mock "M" brand mark — replaced by the real logo later (design note). */}
          <span aria-hidden className="relative font-sans text-xl leading-none font-bold">
            M
          </span>
        </button>
      </Popover.Trigger>
      <AiCalloutMenu context={context} onSelect={() => setOpen(false)} />
    </Popover>
  );
}
