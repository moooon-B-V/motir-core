import { PlanningWorkspaceSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';

// The planning segment's INSTANT-LOADING UI (Bug MOTIR-2069).
//
// Without a `loading.tsx` anywhere on this path, Next.js has no instant-loading
// boundary to show, so a navigation to `/planning` stays parked on the PREVIOUS
// surface until the page's slowest server await settles — the workspace loaded
// first and opened second. This is the boundary that inverts that: the frame
// paints in the first frame after the click, and the page streams into it.
//
// It sits at the GROUP, not at `planning/`, so every future route in the
// planning shell inherits the same open-first behaviour rather than each having
// to remember it. The group layout's session gate still runs ahead of it — an
// unauthenticated visitor is bounced to sign-in, never shown a workspace frame.
export default function PlanningLoading() {
  return <PlanningWorkspaceSkeleton />;
}
