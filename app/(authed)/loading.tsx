import { PageSkeleton } from '@/components/ui/PageSkeleton';

// The authed group's INSTANT-LOADING UI (Subtask MOTIR-3433).
//
// Without a `loading.tsx` on the path, Next.js has no boundary to show, so a
// navigation to any route under `app/(authed)` stays parked on the PREVIOUS
// surface until the destination page's slowest server await settles — the
// address bar has changed and the screen has not, which is exactly what this
// story was reported for. At `origin/main` `dacf711b` the group held 58
// `page.tsx` files and TWO `loading.tsx`. This one file covers the other 56.
//
// It sits at the GROUP, not at a route, for the reason Bug MOTIR-2069 records
// for `(planning)`: every future route in the authed shell inherits open-first
// behaviour rather than each one having to remember it. A route whose shape
// genuinely differs adds a NEARER `loading.tsx` — Next uses the closest
// boundary, so `settings/project/fields/` and `settings/project/components/`
// keep working unchanged, and `/items/[key]` gets its own (MOTIR-3435). Per
// `design/shell/design-notes.md`, a nearer frame composes `PageSkeleton` rather
// than redrawing it, so the wrapper, the header block and the reveal delay stay
// identical across all of them.
//
// ⚠️ The AUTH GATE is unaffected, and structurally cannot be: the group's
// `layout.tsx` awaits `getSession()` and redirects before it renders
// `children`, and a `loading.tsx` is a fallback for the CHILDREN. So an
// unauthenticated visitor is bounced to `/sign-in` and never sees a frame.
export default function AuthedLoading() {
  return <PageSkeleton />;
}
