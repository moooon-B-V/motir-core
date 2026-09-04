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
 * The rail column width tracks the shared `useSidebarCollapsed` store — `240px`
 * expanded, and COLLAPSED it is derived from `--height-control` rather than
 * fixed, so it follows the style axis (56px under the default style, wider
 * under a roomier one; see the comment at the grid). Flipping the footer toggle
 * resizes the grid and the `Sidebar` re-renders icon-only in lockstep (same
 * store).
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
      // The SHELL-CANVAS hook (MOTIR-4230). This root is a full-viewport box with
      // an opaque `--el-page-bg` fill, so it is the last thing standing between a
      // style's `body`-level atmosphere and the user: 3D / Immersive painted its
      // palette-derived depth on `body` and the shell covered it, leaving the
      // frame flat under a style whose whole identity is a whole-page atmosphere.
      // The attribute is what lets the stylesheet repaint that canvas HERE — see
      // the IMMERSIVE BACKGROUND block in `packages/design-system/theme.css`. It
      // is a hook, not a style: a style that paints no atmosphere is unaffected
      // and this root keeps the page fill it has always had.
      data-app-shell=""
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

      {/*
        The COLLAPSED rail column is DERIVED, not a constant (MOTIR-4232). It
        holds exactly one `--height-control` square — `Sidebar`'s collapsed row
        is `h-(--height-control) w-(--height-control)` — so a column stated as a
        raw `56px` is a number that was correct for the one control height that
        existed when it was written, and stops being correct the moment the
        style axis moves that token. Two of the eleven registered styles now set
        it to 40px (`soft-playful`, `3d-immersive`) against a 39px content box,
        and five more sit at 38px with a single pixel to spare.

        `--width-rail-chrome` is the rail's own chrome (its `px-2` gutters plus
        its 1px right border); the SUM is composed here rather than stored as a
        token so that `var(--height-control)` resolves against whatever
        `[data-style]` is in scope on this element, instead of freezing the
        value `:root` happened to have.

        BOTH columns carry `2 * var(--spacing-rail-inset)` (MOTIR-4253), and the
        term is in the COLUMN rather than on the rail for the same reason the
        sum is composed here at all. A style that FLOATS the rail insets it on
        all four sides — but the rail FILLS its cell, so a margin shrinks the
        RAIL and not the cell, and the collapsed rail's content box would drop
        below one `--height-control` square: MOTIR-4232's invariant, broken by
        the fix for a different card. So the column grows by twice the inset and
        the main region gives up that width. The base layer sets the token to
        `0px`, so for the ten styles whose rail has a shared edge both sums
        compile to exactly the numbers they have today.
      */}
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          collapsed
            ? 'md:grid-cols-[calc(var(--height-control)_+_var(--width-rail-chrome)_+_2_*_var(--spacing-rail-inset))_1fr]'
            : 'md:grid-cols-[calc(240px_+_2_*_var(--spacing-rail-inset))_1fr]',
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
