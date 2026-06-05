'use client';

import { type ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils/cn';

/**
 * Tooltip — Radix-wrapped popover that appears on hover + focus.
 *
 * Requires a single TooltipProvider near the app root for delay coordination.
 * For simple use, the default delay (700ms) is fine.
 *
 * @example
 * <Tooltip content="Send message">
 *   <Button variant="ghost"><Send /></Button>
 * </Tooltip>
 */
export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Delay before opening, in ms. Default 700 (Radix default). */
  delayMs?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delayMs = 700,
  className,
}: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayMs}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className={cn(
              'z-50 select-none rounded-(--radius-control)',
              'bg-(--el-text) text-(--el-text-inverted)',
              'px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs',
              'shadow-(--shadow-elevated)',
              'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out fade-in-0 fade-out-0',
              className,
            )}
          >
            {content}
            <RadixTooltip.Arrow className="fill-(--el-text)" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
