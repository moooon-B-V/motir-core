// Typed errors for the error-monitor integration (Story MOTIR-4926 ·
// MOTIR-5258). Kept in their own file so a route handler can import them without
// pulling in the Prisma client or the service. Each carries a discriminating
// `code` the layer above maps to a status or a redirect. Mirrors
// `lib/gitlab/errors.ts`.

/**
 * The binding this write would create already exists — the same *(project,
 * installation, monitored project)* triple is already bound.
 *
 * ⚠️ IT IS RAISED FROM THE DATABASE'S REFUSAL, NOT FROM A GUARDING READ. Binding
 * a project is a check-then-write, and two authorisation returns can land at
 * once: the `monitor_connection_project_id_installation_id_external_proj_key`
 * unique index is what makes exactly one of them win, and this error is how the
 * repository reports the loser's collision. A count-then-write guard with no
 * constraint behind it passes every serial test and only fails under a warm
 * pool, so the read is a courtesy and the constraint is the mechanism.
 *
 * The caller gets a typed refusal it can render — never a generic 500, and never
 * a silent second row.
 */
export class MonitorConnectionAlreadyExistsError extends Error {
  readonly code = 'MONITOR_CONNECTION_ALREADY_EXISTS' as const;
  constructor(
    readonly projectId: string,
    readonly externalProjectId: string,
  ) {
    super(
      `This project is already connected to monitored project ${externalProjectId}. ` +
        'Disconnect it first to re-bind it.',
    );
    this.name = 'MonitorConnectionAlreadyExistsError';
  }
}

/**
 * The stored `provider` discriminator names no implementation the registry knows.
 *
 * A typed error rather than a fallback to the only member: an open discriminant
 * resolved to a plausible default is silent for ever, and the one thing a row
 * from the future should not do is quietly get read as a row from the past.
 * (The registry that raises it lands with the provider seam, MOTIR-5259.)
 */
export class UnknownMonitorProviderError extends Error {
  readonly code = 'UNKNOWN_MONITOR_PROVIDER' as const;
  constructor(readonly provider: string) {
    super(`No monitor provider is registered for "${provider}".`);
    this.name = 'UnknownMonitorProviderError';
  }
}

/**
 * A provider call failed — a non-2xx, an unreachable host, or a response whose
 * shape the adapter could not read.
 *
 * ⚠️ IT CARRIES THE PROVIDER'S OWN REASON STRING, and that is the whole point of
 * the type. The credential-lifecycle card (MOTIR-5261) surfaces this string to a
 * person on the settings surface, so the adapter may not swallow it, summarise
 * it, or replace it with one of ours: a connection that says "something went
 * wrong" is a connection nobody can act on, which is the failure shape
 * MOTIR-4918 recorded one tier up.
 *
 * `status` is null when the call never got a response (a timeout, a dead host) —
 * which is a DIFFERENT fact from a 500, and the one an operator needs to tell
 * "the provider refused us" from "we could not reach the provider".
 */
export class MonitorProviderCallError extends Error {
  readonly code = 'MONITOR_PROVIDER_CALL_FAILED' as const;
  constructor(
    readonly operation: string,
    readonly status: number | null,
    /** The provider's OWN words, passed through unaltered. */
    readonly providerReason: string,
  ) {
    super(
      `Monitor provider call "${operation}" failed${status === null ? '' : ` (${status})`}: ${providerReason}`,
    );
    this.name = 'MonitorProviderCallError';
  }
}

/**
 * This workspace has no monitor grant at all — nothing has been connected, or
 * the last binding was removed and took its credential with it.
 *
 * A distinct type from {@link MonitorConnectionAlreadyExistsError} because the
 * remedy is opposite: this one means "start the install", that one means
 * "you already have this".
 */
export class MonitorGrantNotFoundError extends Error {
  readonly code = 'MONITOR_GRANT_NOT_FOUND' as const;
  constructor(readonly workspaceId: string) {
    super('This workspace has no connected error monitor.');
    this.name = 'MonitorGrantNotFoundError';
  }
}

/**
 * No such binding — or one in another workspace, which is the SAME answer
 * deliberately.
 *
 * The no-existence-leak posture every project-scoped service here keeps: a row
 * that does not exist and a row belonging to another tenant are literally
 * indistinguishable to a caller, so a cross-tenant id cannot be confirmed as
 * real by the shape of the refusal.
 */
export class MonitorConnectionNotFoundError extends Error {
  readonly code = 'MONITOR_CONNECTION_NOT_FOUND' as const;
  constructor(readonly connectionId: string) {
    super('That monitor connection does not exist.');
    this.name = 'MonitorConnectionNotFoundError';
  }
}
