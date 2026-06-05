'use client';

import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import { useShortcut } from '@/lib/hooks/useShortcut';
import { SHORTCUTS } from '@/lib/shortcuts';

/**
 * AppLayout — the frame every signed-in surface renders inside.
 *
 * A two-row shell: a full-width `topNav`, then a content region that is a
 * **two-column CSS grid at `≥md`** (persistent sidebar rail · main) and a
 * **single column below `md`** (sidebar off-canvas — the consumer surfaces it
 * via `<SidebarToggle variant="hamburger" />` + `<SidebarDrawer>`, both in the
 * `topNav`).
 *
 * The rail column width tracks the shared `useSidebarCollapsed` store —
 * `240px` expanded, `56px` collapsed — so flipping the footer toggle resizes
 * the grid and the `Sidebar` re-renders icon-only in lockstep (same store).
 *
 * The first focusable element is a skip-link to `#main`, so keyboard and
 * screen-reader users can jump past the nav straight to content. `<main>`
 * carries `id="main"` + `tabIndex={-1}` so the skip target is programmatically
 * focusable.
 *
 * Data-agnostic: it places the `topNav` / `sidebar` / `children` nodes it's
 * given and owns nothing about their content.
 *
 * @example
 * <AppLayout
 *   topNav={<TopNav />}
 *   sidebar={<Sidebar header={<ProjectSwitcher />} sections={…} footer={<SidebarToggle variant="footer" />} />}
 * >
 *   <DashboardPage />
 * </AppLayout>
 */
export interface AppLayoutProps {
  /** Full-width top bar (workspace switcher, search, theme, avatar, hamburger). */
  topNav: ReactNode;
  /** The persistent rail, shown `≥md`. Typically a `<Sidebar />`. */
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AppLayout({ topNav, sidebar, children, className }: AppLayoutProps) {
  const [collapsed, , toggleCollapsed] = useSidebarCollapsed();

  // ⌘\ (Mac) / Ctrl+\ — toggle the rail from anywhere in the shell. Combo comes
  // from lib/shortcuts.ts, the single source the cheatsheet also reads (1.5.4
  // wires Mod+K / ? against the same hook + module).
  useShortcut(SHORTCUTS.toggleSidebar.combo, toggleCollapsed);

  return (
    <div className={cn('flex h-dvh flex-col overflow-hidden bg-(--el-page-bg)', className)}>
      <a
        href="#main"
        className={cn(
          'sr-only z-[100] focus:not-sr-only focus:absolute focus:left-4 focus:top-3',
          'focus:rounded-(--radius-control) focus:bg-(--el-page-bg) focus:px-4 focus:py-2',
          'focus:font-sans focus:text-sm focus:text-(--el-text) focus:shadow-(--shadow-elevated)',
          'focus:outline-none focus:ring-2 focus:ring-(--focus-ring-color)',
        )}
      >
        Skip to content
      </a>

      <div className="shrink-0">{topNav}</div>

      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          collapsed ? 'md:grid-cols-[56px_1fr]' : 'md:grid-cols-[240px_1fr]',
        )}
      >
        {/* Persistent rail — hidden below md, where the drawer takes over. */}
        <div className="hidden min-h-0 md:block">{sidebar}</div>

        <main id="main" tabIndex={-1} className="min-h-0 overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
