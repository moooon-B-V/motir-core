import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

// The ORGANISATION-settings AREA layout (Story MOTIR-4669 · MOTIR-4710) — the
// third of Motir's three settings tiers to get one. The grouped nav itself lives
// in the app rail: `SidebarNav` swaps to it when the route is inside this area,
// the same "same rail" decision the project (6.5) and account (7.8.12) areas
// made, because the App Router keeps the rail in the parent (authed) layout
// rather than a nested one under <main>.
//
// ⚠️ THIS LAYOUT DELIBERATELY ENFORCES ALMOST NOTHING, and that is the whole
// design rather than an omission. `docs/decisions/organization-tier.md` §6d gates
// this area **PER SECTION, NEVER PER PAGE**:
//
//   org-scoped sections (org name, billing, danger zone, the roster)
//     → org owner/admin only
//   the FOLDED-IN workspace-config sections (name, members, danger zone)
//     → any member of that workspace
//
// Below the workspace-tier reveal the index page hosts BOTH, so a whole-page gate
// here would close the only route a workspace invitee has to their team roster —
// and, critically, to **Leave workspace**, which has no other surface anywhere in
// the product. §6d was written because the collapse as first specified did
// exactly that. A gate at this boundary would reintroduce it one layer up, where
// it is harder to see.
//
// So the pages keep their own per-section treatment, the rail's registry decides
// which ROWS exist, and this layout owns the one precondition every settings area
// shares: an authenticated session. (The parent layout already redirects; the
// re-check is the same belt-and-braces the account area keeps, so a future
// un-authed code path cannot slip through the boundary.)
//
// ⚠️ AND NO `loading.tsx` MAY JOIN IT. `settings/organization/billing/page.tsx`
// calls `notFound()` on a self-host build and `tests/e2e/billing-selfhost.spec.ts`
// asserts the 404. Per CLAUDE.md a `loading.tsx` above an existence-deciding
// route flushes the response head and fixes the status at 200 — and moving the
// gate into a layout does NOT help, because resolving the layout is precisely
// what releases the fallback. A `layout.tsx` alone, as here, is safe; a boundary
// is not.
export default async function OrganizationSettingsAreaLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  return children;
}
