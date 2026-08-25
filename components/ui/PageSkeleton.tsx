import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// PageSkeleton — the pending frame every authed route shows between the click
// and the arrival (Subtask MOTIR-3433, built to `design/shell/navigation-pending`
// and its `design-notes.md` § *The navigation-pending grammar*).
//
// ── What it is for ─────────────────────────────────────────────────────────
// Next.js parks a navigation on the PREVIOUS surface until the destination's
// slowest `await` settles, unless a `loading.tsx` or a `<Suspense>` sits on the
// path. `app/(authed)/loading.tsx` is that boundary for all 58 pages in the
// group, and this is what it renders. `components/ui/` had no skeleton
// primitive before this one, which is why four page-specific skeletons were
// each hand-rolled in their own `_components` folder; those stay as they are
// (each is shaped to its own surface) and this generalises their grammar.
//
// ── The THREE things it owns, and the one it does not ──────────────────────
// The design's nearer-boundary rule: a route that draws its own frame inherits
// the WRAPPER, the HEADER BLOCK and the REVEAL from here, and supplies only the
// BODY. Hence `children` — `/items/[key]`'s own boundary (MOTIR-3435) composes
// this component and passes its two-column shape in, rather than copying three
// rows of markup and drifting from them. Copying instead of composing is the
// same failure as a skeleton restating a table's columns, which is how
// `IssueTreeSkeleton` came to be three columns and 272px behind the table it
// stands in for (MOTIR-3452).
//
// ── The NO-SHIFT contract, which is about heights and NOT widths ───────────
// A settle shift is VERTICAL. The frame and the arriving page both fill
// `<main>`'s width, so a placeholder bar being a different WIDTH from the title
// it stands in for moves nothing — a block-level line box occupies its whole
// line either way. What moves the page is a block whose HEIGHT, or the GAP
// above it, differs from the region that replaces it. So:
//
//   · `h-8` title   — `text-2xl` on a 2rem line box is exactly 32px, which is
//                     what every authed page's `<h1 className="font-serif
//                     text-2xl font-semibold">` occupies.
//   · `h-4` subtitle — the optional `<p>` under the heading. A page WITHOUT one
//                     settles 20px up; the design takes that deliberately (an
//                     upward settle pulls content toward the reader) and says
//                     so in the notes.
//   · `gap-6`       — not a copy of each page's rhythm but the SAME
//                     declaration: Work Items, Roadmap and both shipped
//                     settings `loading.tsx` files all open `flex flex-col
//                     gap-6`.
//
// ⚠️ NO horizontal gutter of its own. `app/(authed)/layout.tsx` already wraps
// `{children}` in `px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8`,
// and this renders INSIDE that wrapper exactly as a page does. Re-applying the
// gutter here would double it at every breakpoint.
//
// ── The REVEAL is CSS, and it is not this file's ───────────────────────────
// `nav-pending-reveal` lives in `app/globals.css` so the ONE keyframe and the
// ONE 120ms delay are referenced by every boundary rather than re-declared by
// each. Two boundaries revealing at two times is the flicker this whole story
// exists to remove, wearing a second costume. Nothing here is a timer: no
// `useEffect`, no `setTimeout`, no client state, and nothing to clean up when a
// navigation is abandoned — the element is removed and the animation goes with
// it. A route that resolves in 40ms unmounts the frame 80ms before it would
// have become visible, and no code had to decide that.

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/**
 * The generic body: a bordered region with a header band and eight rows — the
 * shape a table, list or board settles into. Rendered when a caller passes no
 * `children` of its own.
 *
 * 40px is the shipped table's own row height. Eight rows is a screenful, and is
 * deliberately not a count of anything.
 */
function DefaultBody() {
  const widths = ['w-64', 'w-48', 'w-56', 'w-40', 'w-60', 'w-44', 'w-52', 'w-36'];
  return (
    <div className="overflow-hidden rounded-(--radius-card) border border-(--el-border)">
      <div
        className="border-b border-(--el-border) bg-(--el-surface-soft)"
        style={{ height: 40 }}
      />
      {widths.map((w) => (
        <div
          key={w}
          className="flex items-center gap-4 border-b border-(--el-border) px-4 last:border-b-0"
          style={{ height: 40 }}
        >
          <Block className={`h-3 ${w}`} />
          <div className="flex-1" />
          <Block className="h-3 w-24" />
          <Block className="h-3 w-24" />
          <div className="h-5 w-20 rounded-full bg-(--el-muted)" />
        </div>
      ))}
    </div>
  );
}

export interface PageSkeletonProps {
  /**
   * The route-shaped body. Omit for the generic bordered region above — which
   * is what the GROUP boundary shows, since it stands in for 58 different
   * pages and can assume nothing about any one of them.
   */
  children?: ReactNode;
  /**
   * Draw the subtitle block under the title. Default `true`: most authed pages
   * carry a `<p>` under the heading (Roadmap, Reports, every settings pane).
   * A route-shaped boundary for a page that has none passes `false` and settles
   * flush.
   */
  subtitle?: boolean;
}

export function PageSkeleton({ children, subtitle = true }: PageSkeletonProps) {
  const t = useTranslations('shell');
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
      <div className="flex animate-pulse flex-col gap-6" aria-hidden="true">
        <header className="flex flex-col gap-1">
          <Block className="h-8 w-56" />
          {subtitle ? <Block className="h-4 w-80" /> : null}
        </header>
        <div className="flex items-center gap-2">
          <Block className="h-(--height-control) w-28" />
          <Block className="h-(--height-control) w-24" />
          <div className="flex-1" />
          <Block className="h-(--height-control) w-32" />
        </div>
        {children ?? <DefaultBody />}
      </div>
    </div>
  );
}
