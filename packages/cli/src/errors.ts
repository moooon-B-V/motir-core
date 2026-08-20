// CLI error types. A thrown `CliError` is a clean, user-facing failure: the
// top-level runner (src/index.ts) prints its message to stderr and exits with
// its `exitCode`. Anything else bubbles up as an unexpected crash (stack
// printed), which is the right distinction — a missing link is a CliError, a
// programming bug is not.

export class CliError extends Error {
  readonly exitCode: number;
  /** An optional one-line hint shown under the error (e.g. how to recover). */
  readonly hint: string | undefined;
  /**
   * `cause` is here so a catch that RE-WORDS a failure can keep the original
   * instead of destroying it. Nothing prints it — `src/index.ts` shows the
   * message and the hint — but a rewrite that drops the underlying error leaves
   * no way back to it, and `motir link` proved what that costs (MOTIR-2492).
   * A catch that must re-word: narrow first, then chain.
   */
  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? {} : { cause: opts.cause });
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

/**
 * 403 — a valid token whose GRANT does not include this operation's permission.
 *
 * The permission NAME comes from the generated operation table
 * (`x-motir-permission`, which the server emits from its own operation
 * declarations — MOTIR-2583 checks the two agree), never from parsing
 * the server's English sentence. Re-reading it out of prose would be
 * `isUnauthorized`'s message regex all over again, one status down.
 *
 * Pinned by `docs/decisions/cli-v1-client.md` Q5.
 */
export class PermissionError extends CliError {
  constructor(permission: string, operationId: string) {
    super(`This token is not granted the '${permission}' permission required for ${operationId}.`, {
      exitCode: 1,
      hint: `Grant the '${permission}' permission on a token: Settings → Account → Tokens.`,
    });
    this.name = 'PermissionError';
  }
}

/** 404 with a v1 error envelope — the server's own sentence, kept verbatim. */
export class NotFoundError extends CliError {
  constructor(message: string) {
    super(message, {
      exitCode: 1,
      hint: 'Check the identifier, or run `motir ready` to list what you can reach.',
    });
    this.name = 'NotFoundError';
  }
}

/**
 * 429 — the per-token budget is spent.
 *
 * `x-ratelimit-reset` is Unix epoch SECONDS, and v1 sends no `Retry-After`
 * DELIBERATELY (`lib/api/v1/openapi/headers.ts`: "one absolute instant cannot go
 * stale in transit the way a relative duration can"). So the absolute instant is
 * what the message reports, and the relative hint is derived here.
 */
export class RateLimitError extends CliError {
  constructor(resetAtEpochSeconds: number | undefined, now: Date = new Date()) {
    const resetAt =
      resetAtEpochSeconds === undefined ? undefined : new Date(resetAtEpochSeconds * 1000);
    const when = resetAt ? resetAt.toLocaleTimeString() : 'an unreported time';
    const seconds =
      resetAt === undefined
        ? undefined
        : Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
    super(`Rate limit exceeded. The budget refills at ${when}.`, {
      exitCode: 1,
      hint: seconds === undefined ? 'Retry shortly.' : `Retry in ${seconds} seconds.`,
    });
    this.name = 'RateLimitError';
  }
}

/**
 * A 2xx body the generated validator rejected — the failure the MCP-era cast
 * could not produce.
 *
 * ⚠️ The field is NOT `instancePath` alone. Ajv reports a MISSING property on
 * the PARENT's path with the name in `params.missingProperty`, and an
 * unexpected one the same way via `params.additionalProperty` — so a message
 * built from `instancePath` would say "` ` must have required property" for a
 * renamed server field, which is the single case this whole migration exists to
 * catch. `describeField` below is what makes it name the field.
 */
export class ResponseShapeError extends CliError {
  constructor(serverUrl: string, operationId: string, field: string, detail: string) {
    super(`Unexpected response from ${serverUrl} for ${operationId}: ${field} ${detail}.`, {
      exitCode: 1,
      hint: 'Your CLI and this server may be out of step — run `motir doctor`.',
    });
    this.name = 'ResponseShapeError';
  }
}

/**
 * The CLI and the server speak different `/api/v1` contracts.
 *
 * ONE message per invocation, replacing the per-field defensive branches the
 * MCP era accumulated. See `docs/decisions/cli-v1-client.md` Q3 for what
 * "incompatible" means and why a NEWER minor is silent (ADR §8 is additive-only
 * within a major, so a newer server cannot break a client generated earlier).
 */
export class IncompatibleServerError extends CliError {
  constructor(message: string, hint: string) {
    super(message, { exitCode: 1, hint });
    this.name = 'IncompatibleServerError';
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

/**
 * A plan-approval refused because the plan is not in the status the action
 * needs — carrying WHICH status it is in (MOTIR-3025).
 *
 * ⚠️ IT EXISTS SO A LOOP CAN TELL "NOT YET" FROM "ALREADY DECIDED". An agent
 * submits its re-plan with `--detach` and exits within milliseconds, so an
 * unattended run reaches the approval while the planner is often still writing:
 * `generating` means wait, and `approved` / `declined` mean somebody has already
 * decided and the run must stop. The two are one word apart in the sentence and
 * a caller must not be parsing sentences (`public-api-conventions.md` §8), so
 * the server carries the status as DATA and this is where it lands.
 *
 * A `CliError` in every other respect: printed the same way, exits the same way.
 */
export class PlanNotDecidableError extends CliError {
  readonly planStatus: string;
  constructor(message: string, planStatus: string, opts: { hint?: string } = {}) {
    super(message, opts);
    this.name = 'PlanNotDecidableError';
    this.planStatus = planStatus;
  }
}
