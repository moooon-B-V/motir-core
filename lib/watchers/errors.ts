// Typed errors for the watchers domain (Story 5.4 · Subtask 5.4.4). Kept in
// their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, the service throws these and the route layer translates the
// stable `code` to an HTTP status:
//   WatchersForbiddenError        → 403 (add/remove OTHERS without the
//                                        "Manage watchers" tier — project
//                                        admin / workspace owner-admin)
//   WatcherTargetCannotViewError  → 422 (the target is not a workspace member
//                                        who can VIEW the issue — the typed
//                                        rejection of the Jira silent-drop
//                                        trap; the message names the reason)
//
// The hide-gates reuse the existing domains: a missing / cross-workspace /
// non-browsable issue is WorkItemNotFoundError (finding #44 — 404, no
// existence leak). Watching YOURSELF needs only view access, so the self
// paths throw nothing but the hide-gate.

export class WatchersForbiddenError extends Error {
  readonly code = 'WATCHERS_FORBIDDEN' as const;
  constructor(action: 'add' | 'remove') {
    super(
      `You don't have permission to ${action} watchers for other people on this issue — ` +
        'that needs a project admin (or workspace owner/admin). You can still watch it yourself.',
    );
    this.name = 'WatchersForbiddenError';
  }
}

export class WatcherTargetCannotViewError extends Error {
  readonly code = 'WATCHER_CANNOT_VIEW' as const;
  constructor() {
    super(
      'That person can’t be added as a watcher: a watcher must be a workspace member ' +
        'with permission to view this issue.',
    );
    this.name = 'WatcherTargetCannotViewError';
  }
}
