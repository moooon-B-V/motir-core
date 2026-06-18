'use client';

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { cn } from '@/lib/utils/cn';

/**
 * Popover — anchored, click-outside-dismissable, focus-managed floating
 * panel wrapping @radix-ui/react-popover.
 *
 * Same shape as Modal.tsx (Radix-wrapped, controlled open state). Unlike
 * Modal, the content is anchored to a trigger rather than centered, and
 * there is no overlay — clicking outside dismisses. Use it for menus and
 * dropdowns where the panel holds free-form content (the workspace
 * switcher's section header + membership rows, the user menu).
 *
 * Portal + border + shadow match Modal so the two primitives feel
 * consistent. No new tokens — reuses --radius-card, --shadow-elevated,
 * --color-hairline.
 *
 * @example
 * <Popover open={open} onOpenChange={setOpen}>
 *   <Popover.Trigger asChild>
 *     <Button variant="ghost" rightIcon={<ChevronDown />}>Menu</Button>
 *   </Popover.Trigger>
 *   <Popover.Content align="start">{items}</Popover.Content>
 * </Popover>
 */
export interface PopoverProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children: ReactNode;
}

function PopoverRoot({ open, onOpenChange, modal, children }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      {children}
    </RadixPopover.Root>
  );
}

export interface PopoverContentProps extends ComponentPropsWithoutRef<typeof RadixPopover.Content> {
  /** Panel width; defaults to the 320px the switcher mockup pins. */
  width?: number | string;
  /**
   * Drop the panel's `overflow-hidden` so a child anchored dropdown — e.g. a
   * `Combobox` listbox — can render past the panel's edge instead of being
   * clipped by it. Set this whenever the popover hosts a `Combobox` (or any
   * other absolutely-positioned floating child) whose menu can grow taller
   * than the popover's content-sized height — a real-product Jira-style
   * dropdown-inside-popover (mark-duplicate target, promote sprint picker)
   * always escapes its anchor (`bug-combobox-menu-clipped-inside-popover`).
   *
   * Safe because the popover's own padding (`p-2`, `p-3`) keeps children off
   * the rounded corners, so the corners stay clean without overflow clipping;
   * and the Combobox menu stays in the popover's DOM subtree so non-modal
   * Radix Popover does not treat its clicks as outside-dismissals.
   *
   * Leave unset for popovers that hold only static rows (the workspace
   * switcher, the user menu) — the default `overflow-hidden` is fine and
   * cheaper to reason about.
   */
  overflowVisible?: boolean;
}

const PopoverContent = forwardRef<
  React.ElementRef<typeof RadixPopover.Content>,
  PopoverContentProps
>(function PopoverContent(
  {
    className,
    align = 'start',
    sideOffset = 8,
    width = 320,
    style,
    children,
    overflowVisible = false,
    ...rest
  },
  ref,
) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        // `data-surface` lets a surface-material style (glassmorphism) frost
        // the floating panel — see globals.css's material layer.
        data-surface="popover"
        className={cn(
          'z-50 rounded-(--radius-card) bg-(--el-page-bg)',
          overflowVisible ? 'overflow-visible' : 'overflow-hidden',
          'shadow-(--shadow-elevated) border border-(--el-border)',
          'focus:outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out fade-in-0 fade-out-0',
          className,
        )}
        style={{ width: typeof width === 'number' ? `${width}px` : width, ...style }}
        {...rest}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
});

const PopoverTrigger = RadixPopover.Trigger;
const PopoverClose = RadixPopover.Close;
const PopoverAnchor = RadixPopover.Anchor;

export const Popover = Object.assign(PopoverRoot, {
  Trigger: PopoverTrigger,
  Content: PopoverContent,
  Close: PopoverClose,
  Anchor: PopoverAnchor,
});
