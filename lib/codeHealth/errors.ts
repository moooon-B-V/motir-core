// Typed domain errors for the code-health surface (MOTIR-2247). The route layer
// translates the stable `code` to an HTTP status via `mapCodeHealthError`
// (app/api/ai/coding-convention/_shared.ts), per CLAUDE.md's 4-layer rule — a
// service never returns a status and a route never invents one.
//
// Both live in the 422 family rather than 400: the request is well-formed JSON
// whose VALUE semantics are wrong, which is the line `projectErrorResponse`
// already draws (InvalidAiSettingsError → 422 for an out-of-range threshold,
// InvalidProjectNameError → 400 for a malformed one). A body that is not
// parseable at all never reaches the service — the route answers that 400
// itself.

export abstract class CodeHealthError extends Error {
  abstract readonly code: string;
}

// A repo scope naming one or more repos that are NOT in the project's connected
// set. Raised BEFORE any submit, so a request mixing valid and invalid members
// queues nothing at all — a partial fan-out would spend real money deriving
// half of what was asked for and report an error for the whole.
export class UnknownRepoScopeError extends CodeHealthError {
  readonly code = 'UNKNOWN_REPO_SCOPE' as const;
  constructor(readonly repoKeys: string[]) {
    super(`not connected to this project: ${repoKeys.join(', ')}`);
    this.name = 'UnknownRepoScopeError';
  }
}

// An explicitly EMPTY repo scope. Deliberately an error rather than a
// derive-nothing no-op: a client that computes zero targets and gets a cheerful
// 202 back is indistinguishable from one that worked, so the bug ships silently.
// Note this is NOT the same as sending no scope at all — that keeps the shipped
// whole-set fan-out.
export class EmptyRepoScopeError extends CodeHealthError {
  readonly code = 'EMPTY_REPO_SCOPE' as const;
  constructor() {
    super('a repo scope was supplied but names no repo');
    this.name = 'EmptyRepoScopeError';
  }
}
