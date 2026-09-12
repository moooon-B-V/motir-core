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
