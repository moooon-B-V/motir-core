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
 * of the desktop rail's persisted collapse state.
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
  /** Drawer width in px. Default 300 (the mockup's pin). */
  width?: number;
  className?: string;
}

export function SidebarDrawer({ header, children, width = 300, className }: SidebarDrawerProps) {
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
              className="rounded-(--radius-sm) p-1 text-(--el-text-muted) transition-colors hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
