// The DTO shapes the monitor connection surface crosses the API boundary in
// (Story MOTIR-4926 · MOTIR-5260).
//
// ⚠️ NO SHAPE HERE HAS A TOKEN FIELD, and that is the enforcement rather than
// the intention: a DTO that cannot express a credential cannot leak one into a
// response body, a log line or a client bundle, whatever a mapper is asked to
// do later. The repository's `select`ed summary reads are the same guarantee one
// layer down.

/** One bound monitored project, as the settings room renders it. */
export interface MonitorConnectionDto {
  id: string;
  /** The provider discriminator — what the room shows as the service's name. */
  provider: string;
  /** The provider's own id and slug for the monitored project. */
  externalProjectId: string;
  externalProjectSlug: string;
  /** The GRANT's health, which is what makes a row show `degraded`. It lives on
   *  the installation because the credential does; every binding on one grant
   *  reports the same verdict, which is the truth rather than a simplification. */
  health: 'connected' | 'degraded' | string;
  /** The PROVIDER'S OWN reason for a `degraded` verdict, passed through
   *  unaltered — the string a person acts on. */
  healthReason: string | null;
  healthCheckedAt: string | null;
  /** The provider's organisation slug, when the grant recorded one. Never a
   *  secret — it is what the room says the connection is TO. */
  orgSlug: string | null;
  createdAt: string;
}

/** A monitored project the actor could bind but has not — the picker's row. */
export interface AvailableMonitorProjectDto {
  externalId: string;
  slug: string;
  name: string;
  /** Already bound to THIS Motir project, so the picker can show it as taken
   *  rather than offering a bind that would be refused. */
  bound: boolean;
}

/** What the room needs in one read: the grant (if any) and its bindings. */
export interface MonitorConnectionViewDto {
  /** Null when this project's workspace has no grant at all — the empty state
   *  that carries the connect affordance. */
  installationId: string | null;
  orgSlug: string | null;
  health: string | null;
  healthReason: string | null;
  connections: MonitorConnectionDto[];
}

/** Bind one monitored project to this Motir project. */
export interface BindMonitorProjectInput {
  externalProjectId: string;
  externalProjectSlug: string;
}
