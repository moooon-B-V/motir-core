import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// PageSkeleton — the ONE primitive every in-page arrival frame composes
// (Subtask MOTIR-3531, built to `design/shell/design-notes.md`
// § *WHICH SURFACES EARN A FRAME* rule 4 and § *THE REVEAL DELAY — 120 ms*).
//
// ── What it owns, and what it deliberately does not ────────────────────────
// Rule 4: "`PageSkeleton` owns the wrapper, the header block and the reveal; a
// page passes its body in." Those three, and nothing else. It draws NO content
// region of its own — `children` is required, because a frame that guessed at a
// body would be a shape the page then replaces, which is two frames for one
// navigation.
//
// Copying those three instead of composing them is the drift that put
// `IssueTreeSkeleton` three columns and 272px behind the table it stands in
// for, for eighty days, with its own comment promising it was in sync
// (MOTIR-3452). This story would otherwise create twenty-four more of them.
//
// ── Where it mounts, which is the part that was falsified once ─────────────
// IN THE PAGE, behind a `<Suspense>` BELOW the gate — never a `loading.tsx`
// above one. A route-level boundary flushes a 200 head before the page has
// decided whether the thing exists, which destroyed the 404 on all 11 authed
// routes that decide existence (MOTIR-3492 reverted MOTIR-3433 for exactly
// this). See `motir-core/CLAUDE.md` § *A `loading.tsx` may NOT sit above a
// route that decides existence*.
//
// ── The NO-SHIFT contract, which is about heights and NOT widths ───────────
// A settle shift is VERTICAL. The frame and the arriving page both fill
// `<main>`'s width, so a placeholder bar being a different WIDTH from the title
// it stands in for moves nothing — a block-level line box occupies its whole
// line either way. What moves the page is a block whose HEIGHT, or the GAP
// above it, differs from the region that replaces it. So:
//
//   · `h-8` title    — `text-2xl` on a 2rem line box is exactly 32px, which is
//                      what every authed page's `<h1 className="font-serif
//                      text-2xl font-semibold">` occupies.
//   · `h-4` subtitle — the optional `<p>` under the heading. A page WITHOUT one
//                      settles 20px up; the design takes that deliberately (an
//                      upward settle pulls content toward the reader) and says
//                      so in the notes.
//   · `gap-6`        — not a copy of each page's rhythm but the SAME
//                      declaration: Work Items, Roadmap and both shipped
//                      settings `loading.tsx` files all open `flex flex-col
//                      gap-6`.
//
// ⚠️ NO horizontal gutter of its own. `app/(authed)/layout.tsx` already wraps
// `{children}` in `px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8`,
// and this renders INSIDE that wrapper exactly as a page does. Re-applying the
// gutter here would double it at every breakpoint.
//
// ── The REVEAL is CSS, and it is not this file's ───────────────────────────
// `nav-pending-reveal` lives in `app/globals.css` because a `.tsx` module
// cannot declare `@keyframes`, and because ONE declaration referenced by every
// frame is what keeps the 120ms delay from drifting per surface. Nothing here
// is a timer: no `useEffect`, no `setTimeout`, no client state, and nothing to
// clean up when a navigation is abandoned — the element is removed and the
// animation goes with it.

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/**
 * The header block's three modes, chosen by the caller:
 *
 *   · **omit the prop** — the generic placeholder pair (title bar + subtitle
 *     bar). A generic page cannot know its own title before its first read
 *     returns, so a bar is the honest stand-in.
 *   · **pass a node** — the page's REAL `<h1>` + `<p>`, rendered above the
 *     pulse and outside `aria-hidden`, because it is content and not a
 *     placeholder.
 *   · **pass `false`** — no header block at all. This is what all 31
 *     `settings/**` routes take: a settings pane's title is `t('<pane>.title')`
 *     and its subtitle interpolates a name `getActiveProject()` has already
 *     resolved, so both are painted from the gate ABOVE the boundary. Drawing a
 *     grey bar over a string that already exists would break rule 2 of the
 *     earn-a-frame rule — *a frame only ever covers a region that has NOTHING
 *     to show yet* — on 31 routes at once
 *     (`design/settings/design-notes.md` § *The header is real*).
 */
export type PageSkeletonHeader = ReactNode | false;

export interface PageSkeletonProps {
  /**
   * The route-shaped body — the shape this frame is standing in for. REQUIRED:
   * the primitive draws no content region of its own, so there is no generic
   * body to fall back to and no way to render a frame that stands in for
   * nothing.
   */
  children: ReactNode;
  /** The header block. See {@link PageSkeletonHeader} for the three modes. */
  header?: PageSkeletonHeader;
}

export function PageSkeleton({ children, header }: PageSkeletonProps) {
  const t = useTranslations('shell');
  const drawsGenericHeader = header === undefined;
  const realHeader = header === false || header === undefined ? null : header;
  return (
    <div
      className="nav-pending-frame nav-pending-reveal flex flex-col gap-6"
      aria-busy="true"
      data-testid="page-skeleton"
    >
      {/* Announced ONCE for the whole region. The blocks below are decorative:
          a reader of a screen reader is told the page is loading, not read
          eight placeholder rows. */}
      <span className="sr-only">{t('pageLoading')}</span>
      {/* A REAL header is content, so it sits outside the pulse and outside
          `aria-hidden` — it is the one part of the frame that is not a
          stand-in for something. */}
      {realHeader}
      <div className="flex animate-pulse flex-col gap-6" aria-hidden="true">
        {drawsGenericHeader ? (
          <header className="flex flex-col gap-1">
            <Block className="h-8 w-56" />
            <Block className="h-4 w-80" />
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}
