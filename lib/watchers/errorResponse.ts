import { NextResponse } from 'next/server';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { WatchersForbiddenError, WatcherTargetCannotViewError } from '@/lib/watchers/errors';

/**
 * Shared typed-error → HTTP mapping for the watcher routes (Story 5.4 ·
 * Subtask 5.4.4), the `mapLabelError` pattern. Returns null for errors the
 * route should rethrow.
 *
 *   WorkItemNotFoundError / ProjectNotFoundError → 404 (hidden /
 *     cross-workspace ids are indistinguishable from never-existed ones —
 *     finding #44; the service has already converted browse-denials)
 *   WatchersForbiddenError                       → 403 (managing OTHERS
 *     without the project-admin / workspace owner-admin tier)
 *   WatcherTargetCannotViewError                 → 422 (the typed fix of the
 *     Jira silent-drop trap — the popover surfaces the message inline)
 */
export function mapWatcherError(err: unknown): NextResponse | null {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof WatchersForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof WatcherTargetCannotViewError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
