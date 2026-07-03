'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth';
import { githubIdentityService } from '@/lib/services/githubIdentityService';

// Server Action for the GitHub settings page (MOTIR-895). HTTP/transport layer
// (CLAUDE.md 4-layer): read the session, call exactly ONE service method,
// revalidate. No db.* / $transaction here — the service owns those.

const GITHUB_SETTINGS_PATH = '/settings/workspace/github';

/**
 * Unbind the acting member's GitHub identity. The GitHub settings page is a
 * Server Component read straight from the service, so a `revalidatePath` re-runs
 * that read and the page flips to the not-connected panel (no client island to
 * tick — the page-state contract's server-surface case).
 */
export async function disconnectGithubAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  await githubIdentityService.disconnect(session.user.id);
  revalidatePath(GITHUB_SETTINGS_PATH);
}
