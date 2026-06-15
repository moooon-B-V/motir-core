// CLI error types. A thrown `CliError` is a clean, user-facing failure: the
// top-level runner (src/index.ts) prints its message to stderr and exits with
// its `exitCode`. Anything else bubbles up as an unexpected crash (stack
// printed), which is the right distinction — a missing link is a CliError, a
// programming bug is not.

export class CliError extends Error {
  readonly exitCode: number;
  /** An optional one-line hint shown under the error (e.g. how to recover). */
  readonly hint: string | undefined;
  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

/**
 * The single auth-failure path: an absent / invalid / revoked / expired token.
 * Every MCP call that comes back unauthorized maps HERE, with a uniform
 * re-login hint — the CLI never distinguishes the reason (matching the server's
 * uniform 401, lib/mcp/auth.ts).
 */
export class AuthError extends CliError {
  constructor(message = 'Token invalid or expired.') {
    super(message, { exitCode: 1, hint: 'Run `motir auth login` to authenticate.' });
    this.name = 'AuthError';
  }
}

/** No `.motir.json` binding was found walking up from the cwd. */
export class NotLinkedError extends CliError {
  constructor() {
    super('No Motir project link found in this directory or any parent.', {
      exitCode: 1,
      hint: 'Run `motir link` at your workspace root to bind a project.',
    });
    this.name = 'NotLinkedError';
  }
}
