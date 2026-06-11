import { WatchersForbiddenError, WatcherTargetCannotViewError } from '@/lib/watchers/errors';

// A minimal translator shape — satisfied by next-intl's `getTranslations('errors')`
// result — so this pure mapper stays free of any next-intl import / request
// access (the labelErrorMessage seam, Subtask 5.4.8's pattern).
type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The watcher-domain error union the watch surfaces translate. */
export type WatcherError = WatchersForbiddenError | WatcherTargetCannotViewError;

export function isWatcherError(err: unknown): err is WatcherError {
  return err instanceof WatchersForbiddenError || err instanceof WatcherTargetCannotViewError;
}

/**
 * Maps a typed watcher error to its translated, user-facing message
 * (`errors.watchers.<CODE>`). `targetName` is the display name of the user
 * the manage action targeted — the no-view-access message names them (the
 * design's "<Name> can't view this issue, so they can't watch it." copy);
 * the error object itself carries no fields.
 */
export function watcherErrorMessage(
  err: WatcherError,
  t: ErrorTranslator,
  targetName = '',
): string {
  if (err instanceof WatcherTargetCannotViewError) {
    return t('watchers.WATCHER_CANNOT_VIEW', { name: targetName });
  }
  return t('watchers.WATCHERS_FORBIDDEN');
}
