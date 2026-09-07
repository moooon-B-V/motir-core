'use client';

import { type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MessageCircleQuestion, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import {
  AI_CALLOUT_NAME_KEY,
  aiCalloutActions,
  type AiCalloutIcon,
} from '@/lib/planning/aiCallout';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';

/**
 * AiCalloutMenu — the "M" callout's PANEL (MOTIR-1812 / Story 7.24; design @
 * `design/ai-chat/ai-callout-menu.mock.html` panels 3–5). The floating orb
 * (`PlanWithAIFab`) is the trigger; this is what it opens: a "Motir AI" header
 * plus one row per action the registry (`lib/planning/aiCallout.ts`) offers.
 *
 * It is the shipped `UserMenu` popover idiom one line taller — a bordered
 * header block and `--el-surface` row hover — with the row shape moved onto the
 * element-semantic tokens (`--radius-control`, `--spacing-control-x/y`) that a
 * `data-style` swap can actually reshape, and a focus-visible ring the 240px
 * user menu can do without but a three-row callout with descriptions cannot.
 *
 * Rows are real `<Link>`s, so ⌘/middle-click still opens the workspace in a new
 * tab. Keyboard is Radix's dialog-popover contract, unchanged: Tab walks the
 * rows in DOM order, Esc / outside-click dismiss, focus returns to the orb.
 * There is deliberately NO roving `role="menu"` model — a second, contradictory
 * keyboard model under the same-looking chrome is worse than none, and
 * half-building `menuitem` semantics is worse still.
 */
export interface AiCalloutMenuProps {
  /** The originating context — resolved to the one href every row shares. */
  context: PlanningLaunchContext;
  /** Called when a row is activated, so the trigger can close the panel. */
  onSelect?: () => void;
}

const ICONS: Record<AiCalloutIcon, LucideIcon> = {
  sparkles: Sparkles,
  'message-circle-question': MessageCircleQuestion,
  wrench: Wrench,
};

// The header's accent→highlight wash and the mini orb's hero gradient — the
// same palette-derived recipe the shipped hero pill and the orb already use
// (every input is an `--el-*` token; never a raw hue).
const HEADER_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(135deg, color-mix(in srgb, var(--el-accent) 10%, var(--el-page-bg)), color-mix(in srgb, var(--el-highlight) 10%, var(--el-page-bg)))',
};

const MINI_ORB_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(135deg, var(--el-accent), color-mix(in srgb, var(--el-accent) 55%, var(--el-highlight)))',
};

// The PRIMARY row's tile carries the hero gradient with `--el-accent-text` ink;
// every other row's tile is an accent tint with `--el-accent-on-surface` ink.
// "Primary" is the leading action — marked by the filled tile AND its position,
// never by colour alone.
const PRIMARY_TILE_STYLE: CSSProperties = {
  ...MINI_ORB_STYLE,
  backgroundColor: 'var(--el-accent)',
};

const TILE_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--el-accent) 11%, var(--el-page-bg))',
};

export function AiCalloutMenu({ context, onSelect }: AiCalloutMenuProps) {
  const t = useTranslations('shell');
  // The rows' ONE href, and the click that opens the workspace in place
  // (MOTIR-4730). The registry stays framework-free; this is where the current
  // address enters.
  const { href, open } = useOpenPlanningWorkspace(context);
  const actions = aiCalloutActions(href);

  return (
    <Popover.Content
      // The orb hugs the bottom-right corner: open UPWARD (there is no room
      // below, so Radix can never flip the panel over the trigger), right edges
      // aligned, clear of the orb's outer glow (the primitive's default 8 sits
      // in it) and off every viewport edge when it shifts.
      side="top"
      align="end"
      sideOffset={12}
      collisionPadding={16}
      width="min(288px, calc(100vw - 2rem))"
      aria-label={t(AI_CALLOUT_NAME_KEY)}
      className="pb-1"
    >
      <div
        style={HEADER_STYLE}
        className="flex items-center gap-2 border-b border-(--el-border) px-3 py-2.5"
      >
        <span
          aria-hidden
          style={MINI_ORB_STYLE}
          className="inline-grid h-5.5 w-5.5 flex-none place-items-center rounded-full font-sans text-[11px] leading-none font-bold text-(--el-accent-text)"
        >
          M
        </span>
        <span className="font-sans text-[12.5px] font-semibold text-(--el-text-strong)">
          {t(AI_CALLOUT_NAME_KEY)}
        </span>
      </div>
      <div className="p-1">
        {actions.map((action, index) => {
          const Icon = ICONS[action.icon];
          const isPrimary = index === 0;
          return (
            <Link
              key={action.id}
              href={action.href}
              data-action={action.id}
              onClick={(event) => {
                // The popover closes first, so focus return lands on the orb
                // rather than on a row that is being unmounted.
                onSelect?.();
                open(event);
              }}
              className={cn(
                'flex items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)',
                'text-left hover:bg-(--el-surface) active:bg-(--el-muted)',
                // The keyboard user and the mouse user get the SAME fill; the
                // ring is inset so it never clips at the panel edge.
                'focus-visible:bg-(--el-surface) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring-color)',
              )}
            >
              <span
                aria-hidden
                style={isPrimary ? PRIMARY_TILE_STYLE : TILE_STYLE}
                className={cn(
                  'inline-grid h-6.5 w-6.5 flex-none place-items-center rounded-(--radius-control)',
                  isPrimary ? 'text-(--el-accent-text)' : 'text-(--el-accent-on-surface)',
                )}
              >
                <Icon className="h-[15px] w-[15px]" />
              </span>
              <span className="min-w-0">
                <span className="block font-sans text-[13px] leading-snug font-semibold text-(--el-text)">
                  {t(action.titleKey)}
                </span>
                {/* Secondary, never muted — `--el-text-muted` fails AA at this size. */}
                <span className="mt-px block font-sans text-[11.5px] leading-snug text-(--el-text-secondary)">
                  {t(action.descriptionKey)}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </Popover.Content>
  );
}
