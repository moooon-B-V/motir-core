import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

// The WORKSPACE-settings AREA layout (Story MOTIR-4843 · MOTIR-4846) — the
// fourth and last of Motir's settings tiers to get one. The grouped nav itself
// lives in the app rail: `SidebarNav` swaps to it when the route is inside this
// area, the same "same rail" decision the project (6.5), account (7.8.12) and
// organisation (MOTIR-4710) areas made, because the App Router keeps the rail in
// the parent (authed) layout rather than a nested one under <main>.
//
// ⚠️ THIS LAYOUT OWNS NO TIER GATE, AND THAT IS DELIBERATE. All three pages
// under it call `notFound()` themselves below the workspace-tier reveal, and the
// check MUST stay in the page — see the boundary note below. This layout owns
// only the one precondition every settings area shares: an authenticated
// session. (The parent layout already redirects; the re-check is the same
// belt-and-braces the account and organisation areas keep, so a future un-authed
// code path cannot slip through the boundary.)
//
// ⚠️ AND NO `loading.tsx` MAY JOIN IT. Every page here DECIDES EXISTENCE. Per
// `CLAUDE.md` § *A `loading.tsx` may NOT sit above a route that decides
// existence*, a boundary above such a segment can render as soon as its ancestor
// layouts resolve — which flushes the response head and fixes the status at 200,
// turning the `notFound()` into a 200 with a 404 body. **Hoisting the gate into
// this layout does NOT recover it**: a layout is an ANCESTOR of the boundary, so
// resolving it is precisely what releases the fallback. That was built and
// measured, not assumed. A `layout.tsx` alone, as here, is safe; a boundary is
// not, and `tests/navigation/loading-boundary-guard.test.ts` enforces it.
export default async function WorkspaceSettingsAreaLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  return children;
}
