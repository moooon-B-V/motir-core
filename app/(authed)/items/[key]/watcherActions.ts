'use server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { redirect } from 'next/navigation';
import { watchersService } from '@/lib/services/watchersService';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { isWatcherError, watcherErrorMessage } from '@/lib/watchers/errorMessages';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { WatcherDto } from '@/lib/dto/watchers';

// Server Actions for the detail header's watch control + watchers popover
// (Story 5.4 · Subtask 5.4.9). One service call each; the success branch
// returns the new state — the control reconciles its optimistic bump from
// THIS response, with NO `router.refresh()` on success (the inline-edit
// rule: the refresh fan-out is what caused the status-revert bug; the
// response is the authority). A typed 422/403 comes back as the translated
// `error` string the popover renders inline (the mock's pop-err grammar).
// The paged LIST read stays on the GET /api/work-items/[id]/watchers route —
// the popover fetches it on open (reads don't need an action).

export type WatchToggleResult =
  | { ok: true; watching: boolean; watcherCount: number }
  | { ok: false; error: string };

export type AddWatcherResult =
  | { ok: true; watcher: WatcherDto; watcherCount: number }
  | { ok: false; error: string };

export type RemoveWatcherResult = { ok: true; watcherCount: number } | { ok: false; error: string };

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

async function watcherFailure(
  err: unknown,
  targetName: string,
): Promise<{ ok: false; error: string }> {
  const t = await getErrorsTranslator();
  if (isWatcherError(err)) return { ok: false, error: watcherErrorMessage(err, t, targetName) };
  if (err instanceof WorkItemNotFoundError) {
    // The service converts browse denials to not-found itself (finding #44 —
    // no existence leak), so this is the only non-watcher error it surfaces.
    return { ok: false, error: workItemErrorMessage(err, t) };
  }
  throw err;
}

/** Self watch/unwatch — the eye control (and its `W` shortcut). */
export async function toggleWatchAction(input: {
  workItemId: string;
  watch: boolean;
}): Promise<WatchToggleResult> {
  const ctx = await requireContext();
  try {
    const state = input.watch
      ? await watchersService.watch(input.workItemId, ctx)
      : await watchersService.unwatch(input.workItemId, ctx);
    return { ok: true, ...state };
  } catch (err) {
    return watcherFailure(err, '');
  }
}

/**
 * Add ANOTHER user as a watcher — the popover's admin-only member-picker row.
 * `userName` is display-only: the typed no-view-access 422 names the person
 * (the design's inline-error copy), so the action threads it to the
 * translator; the service validates by `userId` alone.
 */
export async function addWatcherAction(input: {
  workItemId: string;
  userId: string;
  userName: string;
}): Promise<AddWatcherResult> {
  const ctx = await requireContext();
  try {
    const result = await watchersService.addWatcher(input.workItemId, input.userId, ctx);
    return { ok: true, ...result };
  } catch (err) {
    return watcherFailure(err, input.userName);
  }
}

/** Remove a user from the roster — the popover's admin-only per-row ×. */
export async function removeWatcherAction(input: {
  workItemId: string;
  userId: string;
}): Promise<RemoveWatcherResult> {
  const ctx = await requireContext();
  try {
    const result = await watchersService.removeWatcher(input.workItemId, input.userId, ctx);
    return { ok: true, ...result };
  } catch (err) {
    return watcherFailure(err, '');
  }
}
