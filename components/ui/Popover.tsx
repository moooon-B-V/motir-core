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
}

const PopoverContent = forwardRef<
  React.ElementRef<typeof RadixPopover.Content>,
  PopoverContentProps
>(function PopoverContent(
  { className, align = 'start', sideOffset = 8, width = 320, style, children, ...rest },
  ref,
) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 overflow-hidden rounded-(--radius-card) bg-(--el-page-bg)',
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
