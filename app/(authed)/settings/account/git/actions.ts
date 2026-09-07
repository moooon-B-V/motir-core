'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { githubIdentityService } from '@/lib/services/githubIdentityService';

// The Git-accounts pane's one mutation (Story MOTIR-4669 · MOTIR-4682).
//
// ⚠️ IT TAKES NO ARGUMENT, and that is the security property rather than an
// ergonomic one. `GithubIdentity` is `userId @unique` — a personal credential —
// so the only identity this action can reach is the SESSION's. There is no id to
// pass and therefore none to tamper with, and `githubIdentityService.disconnect`
// runs under `withUserContext` so RLS narrows the delete to the owner's row a
// second time. One user cannot disconnect another's account by construction.
//
// ⚠️ IT NEVER TOUCHES THE ORGANISATION'S INSTALLATION. The two grants are
// INDEPENDENT — the shipped connect page says so in as many words — so
// disconnecting a member's identity leaves `GithubInstallation` exactly as it
// was. A member leaving is not an organisation disconnecting, and the service's
// own comment records that the App is uninstalled on GitHub, never here.
export async function disconnectGitAccountAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  await githubIdentityService.disconnect(session.user.id);

  // The pane is server-rendered from one read, so the page-state contract's
  // second surface (`CLAUDE.md`) is the whole of it: no client island holds this
  // list, so a revalidate is what updates it and there is no tick to bump.
  revalidatePath('/settings/account/git');
}
