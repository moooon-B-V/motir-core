import { PageSkeleton } from '@/components/ui/PageSkeleton';

// The work-item detail page's OWN pending frame (Subtask MOTIR-3435), drawn in
// `design/work-items/detail-arrival` and composing the shell grammar from
// `design/shell/design-notes.md` § *The navigation-pending grammar*.
//
// ── Why this route earns a nearer boundary ─────────────────────────────────
// `app/(authed)/loading.tsx` covers all 58 authed pages with a generic frame,
// and for 57 of them that is the right answer. This page is the exception the
// group frame is a poor stand-in for: it has an eyebrow ROW above its title, a
// two-column split, and a rail — none of which a frame standing in for 58
// different pages can assume. Next uses the nearest boundary, so this replaces
// the group's frame for this route only, and the group's keeps serving the rest.
//
// ── It COMPOSES; it does not redraw ────────────────────────────────────────
// The design's nearer-boundary rule: a route-shaped frame inherits the WRAPPER,
// the HEADER BLOCK and the REVEAL from `PageSkeleton` and supplies only its
// BODY. So there is no second `nav-pending-reveal`, no second `gap-6` wrapper
// and no second title box here — two boundaries revealing at two times is the
// flicker this story exists to remove, wearing a second costume. Copying those
// three rows instead of composing them is the same drift as a skeleton
// restating a table's columns, which is how `IssueTreeSkeleton` came to be
// three columns behind the table it stands in for (MOTIR-3452).
//
// `subtitle={false}`: this page's `<h1>` has no `<p>` under it — the eyebrow
// sits ABOVE the title, not below — so the frame would otherwise reserve a line
// the arrived page never fills and settle 20px up.

/** One pulsing placeholder block. Fill + radius through tokens only. */
function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}

/** A pending section card — the real `ContentSectionCard` chrome, body on pulse. */
function CardFrame({ titleWidth, rows }: { titleWidth: string; rows: string[] }) {
  return (
    <div
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-card)"
      data-surface="card"
    >
      <div className="mb-(--spacing-md)">
        <Block className={`h-5 ${titleWidth}`} />
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((w) => (
          <Block key={w} className={`h-3 ${w}`} />
        ))}
      </div>
    </div>
  );
}

export default function ItemDetailLoading() {
  return (
    <PageSkeleton
      subtitle={false}
      toolbar={false}
      titleWidth="w-[34rem]"
      // The EYEBROW row — type glyph · identifier · breadcrumb · right cluster.
      // Its wrapper repeats the page's own `flex flex-wrap items-center gap-x-3
      // gap-y-2`, and the breadcrumb cell is `min-w-0 flex-1` exactly as the
      // page's is — so the row's height is the glyph's at every width and the
      // truncation track is bounded (the shipped fix for the eyebrow
      // overflowing the viewport).
      eyebrow={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Block className="h-5 w-5" />
          <Block className="h-4 w-24" />
          <div className="min-w-0 flex-1">
            <Block className="h-3.5 w-72" />
          </div>
          <div className="flex items-center gap-2">
            <Block className="h-(--height-control) w-28" />
            <Block className="h-(--height-control) w-9" />
            <Block className="h-(--height-control) w-9" />
          </div>
        </div>
      }
    >
      {/* The two-column split — the page's OWN declaration, not a copy of its
          measurements, so it collapses to one column below `md` in the frame
          exactly as it does on the page. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <CardFrame titleWidth="w-28" rows={['w-full', 'w-full', 'w-4/5']} />
          <CardFrame titleWidth="w-32" rows={['w-full', 'w-3/4']} />
          <CardFrame titleWidth="w-36" rows={['w-2/3', 'w-1/2']} />
        </div>
        <aside className="flex flex-col gap-4">
          <CardFrame
            titleWidth="w-24"
            rows={['w-full', 'w-5/6', 'w-full', 'w-2/3', 'w-4/5', 'w-1/2']}
          />
        </aside>
      </div>
    </PageSkeleton>
  );
}
