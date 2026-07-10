'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { GitlabConnectionNotFoundError, GitlabProjectNotFoundError } from '@/lib/gitlab/errors';
import type { GitlabSelectableProjectDTO } from '@/lib/dto/gitlab';

// Server Actions for the GitLab settings surface (Story 7.23 · MOTIR-1478). HTTP/
// transport layer (CLAUDE.md 4-layer): read the session + workspace context, call
// exactly ONE service method, revalidate. No db.* / $transaction here — the
// service owns those. GitLab connections are WORKSPACE-scoped (unlike GitHub's
// user identity), so every action resolves the acting member's active workspace.
//
// The list/connect actions return a typed result the client picker (Panel 2b)
// renders — a `kind` discriminator the client translates via `useTranslations`,
// so no user-facing copy is built server-side.

const GITLAB_SETTINGS_PATH = '/settings/workspace/gitlab';

export type ProjectActionError = 'not_connected' | 'not_found' | 'unavailable';

/**
 * Disconnect the workspace's whole GitLab connection. The settings page is a
 * Server Component read straight from the service, so a `revalidatePath` re-runs
 * the read and the page flips to the not-connected panel (the page-state
 * contract's server-surface case — no client island to tick).
 */
export async function disconnectGitlabAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  await gitlabConnectionService.disconnect({ userId: ctx.userId, workspaceId: ctx.workspaceId });
  revalidatePath(GITLAB_SETTINGS_PATH);
}

/**
 * List the user's GitLab projects for the in-app picker (Panel 2b). A live read
 * through the GitProvider seam — a revoked authorization surfaces as
 * `error: 'unavailable'` (the picker shows the reconnect hint). Not revalidating:
 * a read, and the picker holds the result in client state.
 */
export async function listGitlabProjectsAction(): Promise<
  { ok: true; projects: GitlabSelectableProjectDTO[] } | { ok: false; error: ProjectActionError }
> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: 'not_connected' };
  try {
    const projects = await gitlabConnectionService.listSelectableProjects({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { ok: true, projects };
  } catch (err) {
    if (err instanceof GitlabConnectionNotFoundError) return { ok: false, error: 'not_connected' };
    // A live-enumeration failure (revoked authorization / GitLab unreachable).
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * Connect one GitLab project to the workspace (persist the selection). The
 * projects card is server-rendered, so on success we `revalidatePath` and the
 * client also `router.refresh()`es — the new row appears.
 */
export async function connectGitlabProjectAction(
  repoId: string,
): Promise<{ ok: true } | { ok: false; error: ProjectActionError }> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) return { ok: false, error: 'not_connected' };
  try {
    await gitlabConnectionService.connectProject(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      repoId,
    );
    revalidatePath(GITLAB_SETTINGS_PATH);
    return { ok: true };
  } catch (err) {
    if (err instanceof GitlabConnectionNotFoundError) return { ok: false, error: 'not_connected' };
    if (err instanceof GitlabProjectNotFoundError) return { ok: false, error: 'not_found' };
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * Disconnect one GitLab project (remove the selection). Idempotent in the service;
 * the projects card is server-rendered, so `revalidatePath` re-reads it.
 */
export async function disconnectGitlabProjectAction(repoId: string): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) return;
  await gitlabConnectionService.disconnectProject(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    repoId,
  );
  revalidatePath(GITLAB_SETTINGS_PATH);
}
