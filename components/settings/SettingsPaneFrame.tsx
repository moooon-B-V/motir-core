import { type CSSProperties } from 'react';
import { PageSkeleton } from '@/components/ui/PageSkeleton';

// SettingsPaneFrame — the arrival frame all 31 `settings/**` routes mount
// IN-PAGE, below their own gate (Subtask MOTIR-3558, built to
// `design/settings/arrival.mock.html` and its `design-notes.md`).
//
// ── What it is ────────────────────────────────────────────────────────────
// `PageSkeleton` with the header block OMITTED, standing in for the pane's
// CARD and nothing else. It is what goes inside the `<Suspense>`:
//
//   mx-auto flex max-w-[Wrem] flex-col gap-6   the pane wrapper — THE PAGE'S OWN
//     header  flex flex-col gap-1              THE REAL HEADER: <h1> + <p>
//     <Suspense fallback={<SettingsPaneFrame />}>
//       …the pane body…
//
// ── Why it has NO header, which is the family's whole difference ──────────
// A generic page draws a title bar because a generic page cannot know its own
// title before its first read returns. A settings pane can: its title is
// `t('<pane>.title')` and its subtitle interpolates a name `getActiveProject()`
// has ALREADY resolved by the time the gate finishes. Both are therefore
// painted from the gate, ABOVE the boundary, and a frame that drew a grey bar
// over them would cover a region that has something to show — rule 2 of
// `design/shell/design-notes.md` § WHICH SURFACES EARN A FRAME, broken on 31
// routes at once. `PageSkeleton`'s `header={false}` mode exists for this
// (MOTIR-3531).
//
// ── Why it takes NO width prop ────────────────────────────────────────────
// The family's one real hazard is horizontal: every settings pane is a centred
// column (`mx-auto max-w-[Wrem]`) across EIGHT distinct widths, so a frame at
// the wrong W slides the content sideways on settle — 144px each side for a
// 42rem frame in front of the 60rem Job-runs pane
// (`design/settings/design-notes.md` § The WIDTH axis).
//
// The asset's anatomy removes that hazard rather than parameterising it: the
// column wrapper is **the page's own**, and this frame renders INSIDE it as the
// boundary's fallback. So the width is inherited by construction and the two
// cannot disagree — which is strictly safer than a prop the page must remember
// to keep in sync, and it is why this component has no `mx-auto` and no
// `max-w-*` of its own. (The card's AC 2 asked for W as a prop; the merged
// asset outranks it. Amended on MOTIR-3558.)
//
// ── What it does NOT own ─────────────────────────────────────────────────
// The wrapper's flex/gap rhythm, the 120ms reveal, the pulse and the single
// `aria-busy` announcement are `PageSkeleton`'s, composed and never re-drawn.
// This module declares no keyframe and references no animation of its own.
//
// It also does not reserve `settings/project/board`'s breadcrumb line. That
// line sits ABOVE the `<h1>` — inside the real header, above this boundary —
// so it belongs to that page's header, not to the fallback beneath it. It is
// row 2's, on MOTIR-3443.

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className, style }: { className: string; style?: CSSProperties }) {
  return (
    <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} style={style} />
  );
}

/**
 * The card stand-in — `settings/project/fields/loading.tsx`'s composition with
 * its two HEADER placeholders removed, because the real header is painted above
 * the boundary now.
 *
 * Three rows is a screenful for a 42–46rem pane and is deliberately not a count
 * of anything. The 40 / 48 / 56% bar widths are the shipped skeleton's own, and
 * the two files this replaces had already drifted from each other in the two
 * numbers that DID differ (a `w-32` title against a `w-40`, a `w-24` action bar
 * against a `w-28`) — which is the drift a shared drawing exists to stop.
 */
export function SettingsPaneFrame() {
  return (
    <PageSkeleton header={false}>
      <div
        className="rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)"
        data-testid="settings-pane-frame"
      >
        <div className="mb-4 flex items-center justify-between">
          <Block className="h-4 w-32" />
          <div className="h-7 w-24 rounded-(--radius-btn) bg-(--el-muted)" />
        </div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Block className="size-8" />
              <Block className="h-3.5" style={{ width: `${40 + i * 8}%` }} />
            </div>
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}
