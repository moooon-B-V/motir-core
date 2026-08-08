'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useSidebarDrawer } from '@/lib/hooks/useSidebarDrawer';
import { useShortcut } from '@/lib/hooks/useShortcut';

/**
 * SidebarDrawer — the `<md` off-canvas navigation drawer.
 *
 * Wraps `@radix-ui/react-dialog` (so focus trap, ESC-to-close, and
 * click-the-scrim-to-dismiss come for free) but, unlike `Modal`, the panel is
 * pinned to the left edge and slides in from `translate-x-[-100%]` →
 * `translate-x-0`, driven entirely by Radix's `data-state`. That left-anchored
 * geometry is exactly what `Modal`'s centered variant can't express, which is
 * why the drawer talks to Radix directly instead of reusing `Modal`.
 *
 * Open/closed lives in the shared `useSidebarDrawer` store, so the
 * `<SidebarToggle variant="hamburger" />` in the top nav and this drawer stay
 * in sync without a provider. The drawer also:
 *   - **auto-closes on route change** — a navigation means the user picked a
 *     destination, so the drawer shouldn't linger over the new page;
 *   - registers `esc` through the shared `useShortcut` hook as a belt-and-
 *     suspenders close (Radix already handles ESC; this keeps the shell's
 *     shortcut registry the single source of truth).
 *
 * `header` is the drawer's top bar (the workspace switcher in the mockup),
 * shown beside the close button. `children` is the drawer body — pass a
 * `<Sidebar collapsed={false} … />` so it always renders expanded regardless
 * of the desktop rail's persisted collapse state. `footer` is the UTILITY STRIP
 * (below) — the room the top bar's displaced controls moved into.
 *
 * ## The utility strip (MOTIR-2373 · design/shell design-notes.md Panel D)
 *
 * The below-`md` top bar is closed at four slots, so the controls that no longer
 * fit — the build-in-public slot, the report button, the theme toggle — need a
 * DRAWN home rather than a cited one. This is it: a footer strip with the
 * geometry of the drawer's own header, mirrored to the bottom edge. The door is
 * the hamburger the bar already carries; this is the room.
 *
 * Nothing in the strip is a new component — each control is the element that
 * left the bar, re-homed. It is a horizontal row rather than `SidebarItem` rows
 * because a `SidebarItem` is an `href` link and these are buttons and stateful
 * slots. The strip renders only when a `footer` is passed, so the `/tokens`
 * specimen mount is unaffected.
 *
 * The drawer is breakpoint-agnostic — the `<md`-only gating lives on its
 * trigger (the consumer wraps `<SidebarToggle variant="hamburger" />` in
 * `md:hidden`), not here, so it can open over the page at any width when
 * deliberately triggered (e.g. the `/tokens` preview).
 *
 * @example
 * <SidebarDrawer header={<WorkspaceSwitcher />}>
 *   <Sidebar collapsed={false} header={<ProjectSwitcher />} sections={…} />
 * </SidebarDrawer>
 */
export interface SidebarDrawerProps {
  /** Top-bar content beside the close button (e.g. the workspace switcher). */
  header?: ReactNode;
  /** The drawer body — typically a `<Sidebar collapsed={false} … />`. */
  children: ReactNode;
  /**
   * The utility strip's contents — the controls displaced from the below-`md`
   * top bar, left to right: the build-in-public slot (labelled, in a
   * `min-w-0 flex-1` wrapper so it truncates rather than pushing), then the
   * report button, then the theme toggle. Omit it and no strip renders.
   */
  footer?: ReactNode;
  /** Drawer width in px. Default 300 (the mockup's pin). */
  width?: number;
  className?: string;
}

export function SidebarDrawer({
  header,
  children,
  footer,
  width = 300,
  className,
}: SidebarDrawerProps) {
  const [open, setOpen] = useSidebarDrawer();

  // Auto-close on route change. Compare the previous pathname to the current
  // one and close on transition — Radix won't know the user navigated.
  const pathname = usePathname();
  const prevPathname = useRef(pathname);
  useEffect(() => {
    if (prevPathname.current !== pathname) {
      prevPathname.current = pathname;
      if (open) setOpen(false);
    }
  }, [pathname, open, setOpen]);

  // Shared-registry ESC close (fires even while a field inside the drawer is
  // focused). Radix also closes on ESC; this keeps the shortcut centralized.
  useShortcut('esc', () => setOpen(false), { whenInputFocused: true, enabled: open });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content
          // No `description` → declare the explicit opt-out so Radix doesn't
          // warn about a missing aria-describedby (mirrors Modal, FINDINGS #8).
          aria-describedby={undefined}
          style={{ width: `${width}px` }}
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex flex-col',
            'bg-(--el-sidebar-bg) shadow-(--shadow-modal)',
            'transition-transform duration-(--transition-duration) ease-out',
            'translate-x-[-100%] data-[state=open]:translate-x-0',
            'focus:outline-none',
            className,
          )}
        >
          {/* Radix requires a Title for the accessible name; the visual title
              is the workspace switcher in the header, so this stays sr-only. */}
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>

          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-(--el-sidebar-border) px-3">
            <div className="min-w-0 flex-1">{header}</div>
            <Dialog.Close
              aria-label="Close navigation"
              className="rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) transition-colors hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

          {/* The utility strip — the drawer header's geometry mirrored to the
              bottom edge (design/shell Panel D). `shrink-0` keeps it pinned
              while the nav above scrolls. */}
          {footer ? (
            <div className="flex h-14 shrink-0 items-center gap-2 border-t border-(--el-sidebar-border) px-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
