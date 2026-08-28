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
  /**
   * An app-wide notice pinned ABOVE the top bar, on every signed-in route.
   *
   * A slot rather than a fixed overlay, so the bar participates in the shell's
   * flex column: the root is `h-dvh overflow-hidden`, so anything rendered as a
   * SIBLING of this frame would push it past the viewport, and anything
   * `fixed` would sit on top of the nav rather than above it. Given a node, the
   * two rows below simply become three.
   *
   * Its first consumer is the account-deletion banner (MOTIR-3704), which
   * design DECISION 4 requires on every page — *"a grace period is only
   * reachable if the reader can find it"*. Data-agnostic like every other slot:
   * this component knows nothing about what a banner says or when there is one.
   */
  banner?: ReactNode;
  /** Full-width top bar (workspace switcher, search, theme, avatar, hamburger). */
  topNav: ReactNode;
  /** The persistent rail, shown `≥md`. Typically a `<Sidebar />`. */
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AppLayout({ banner, topNav, sidebar, children, className }: AppLayoutProps) {
  const [collapsed, , toggleCollapsed] = useSidebarCollapsed();

  // ⌘\ (Mac) / Ctrl+\ — toggle the rail from anywhere in the shell. Combo comes
  // from lib/shortcuts.ts, the single source the cheatsheet also reads (1.5.4
  // wires Mod+K / ? against the same hook + module).
  useShortcut(SHORTCUTS.toggleSidebar.combo, toggleCollapsed);

  /*
    `relative` on the root below is what makes its `overflow-hidden` MEAN
    anything (MOTIR-3286).

    `overflow` clips a descendant only when that descendant's CONTAINING BLOCK is
    inside the clipping box. An absolutely positioned element with no positioned
    ancestor resolves its containing block to the INITIAL one, so it is not
    clipped by this root at all — and its static position, the place it would
    have taken in `<main>`'s flow, extends the DOCUMENT's scrollable overflow to
    reach it. One 1px `sr-only` span deep inside a long page was enough: measured
    on the live app, `documentElement.scrollHeight` 1364 against a `clientHeight`
    of 371. The whole shell then scrolls up as a block and leaves an empty band
    of body canvas below its bottom edge — reported twice, and not what
    MOTIR-3208's `vh`/`dvh` correction was fixing.

    So both clipping boxes on the shell path — this root and `<main>` — are
    positioned. That is the only place the containing block can be settled for
    every descendant that will ever exist; anchoring the one span that escaped
    would leave the invariant resting on each future author remembering not to
    write a bare `absolute`.
  */
  return (
    <div
      className={cn('relative flex h-dvh flex-col overflow-hidden bg-(--el-page-bg)', className)}
    >
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

      {/* `shrink-0` for the same reason the nav has it: the frame is a fixed-
          height flex column, so a banner that could shrink would be squeezed
          out by a tall page instead of holding its row. */}
      {banner ? <div className="shrink-0">{banner}</div> : null}

      <div className="shrink-0">{topNav}</div>

      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          collapsed ? 'md:grid-cols-[56px_1fr]' : 'md:grid-cols-[240px_1fr]',
        )}
      >
        {/* Persistent rail — hidden below md, where the drawer takes over. */}
        <div className="hidden min-h-0 md:block">{sidebar}</div>

        {/*
          `<main>` is the ONLY scroller on any signed-in surface — the root above
          is `h-dvh overflow-hidden`, so the document itself never scrolls
          (MOTIR-3208).

          Both axes are stated. Left implicit, `overflow-x` does not stay
          `visible`: CSS Overflow 3 computes it to `auto` whenever the other axis
          is non-visible, so the shell's one scroller would acquire a horizontal
          bar nobody chose. `auto` is what it is set to deliberately — content
          wider than the column (a wide table, a code block, a board) must stay
          REACHABLE, and clipping it would make it permanently unreachable in a
          shell whose document cannot scroll to reveal it.

          `relative` for the reason stated above the root (MOTIR-3286): it is a
          clipping box, so it must also be a containing block, or what it clips
          is only the descendants that happen to have a positioned ancestor.
          Anchoring HERE rather than only at the root is what keeps an escapee
          scrolling WITH the content it was written beside, instead of pinned to
          the shell — the root alone would stop the document growing and leave
          the element in the wrong place.
        */}
        <main
          id="main"
          tabIndex={-1}
          className="relative min-h-0 overflow-y-auto overflow-x-auto focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
