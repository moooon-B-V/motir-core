import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

// The account-settings AREA layout (Story 7.8 · Subtask 7.8.12). The grouped
// account-settings NAV itself lives in the app rail — SidebarNav swaps to it when
// the route is inside this area (the same "same rail" decision as the 6.5 project
// area; the App Router keeps the rail in the parent (authed) layout, not a nested
// one under <main>).
//
// Unlike the project area, this layout has no project/access guard to enforce:
// account settings are the signed-in user's OWN personal preferences, always
// available regardless of the active workspace/project. The only precondition is
// an authenticated session (the parent layout already redirects, but we re-check
// at the area boundary so a future un-authed code path can't slip through).
export default async function AccountSettingsAreaLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  return children;
}
