// Typed errors for the import RUN service (Story 7.16 · MOTIR-941). The route
// layer translates these to HTTP status codes (the 4-layer rule); the service
// never returns a bare Prisma / connector error to the transport. Connector
// (source-reachability) errors live in `lib/import/connectors/errors.ts`; these
// are the persist-engine + import-lifecycle errors.

/** The `Import` id does not exist in the acting workspace (a cross-workspace /
 *  unknown id is indistinguishable from never-existed — 404, no existence
 *  leak). */
export class ImportNotFoundError extends Error {
  readonly code = 'IMPORT_NOT_FOUND';
  constructor(public readonly importId: string) {
    super(`Import ${importId} not found`);
    this.name = 'ImportNotFoundError';
  }
}

/** A run was requested on an Import already `running` — a second concurrent run
 *  of the SAME import is rejected (the run-status guard that keeps a re-run from
 *  racing itself into duplicates). 409. */
export class ImportAlreadyRunningError extends Error {
  readonly code = 'IMPORT_ALREADY_RUNNING';
  constructor(public readonly importId: string) {
    super(`Import ${importId} is already running`);
    this.name = 'ImportAlreadyRunningError';
  }
}

/** The acting member lacks a live token / connection for the Import's source, so
 *  a live connector cannot be built (the CSV path needs none). 422 — the user
 *  must connect the source first (MOTIR-943). */
export class ImportSourceNotConnectedError extends Error {
  readonly code = 'IMPORT_SOURCE_NOT_CONNECTED';
  constructor(public readonly source: string) {
    super(`No connected identity for import source "${source}"`);
    this.name = 'ImportSourceNotConnectedError';
  }
}

/** The request did not carry the per-source connection config a connector needs
 *  (e.g. a Jira base URL, or the CSV file content). 422. */
export class ImportConnectionConfigError extends Error {
  readonly code = 'IMPORT_CONNECTION_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ImportConnectionConfigError';
  }
}
