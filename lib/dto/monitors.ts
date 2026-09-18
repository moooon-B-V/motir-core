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

  // ── INGESTION STATE (Story MOTIR-4929 · Subtask MOTIR-5579) ─────────────────
  // What the room shows about whether this binding's issues are ARRIVING. Every
  // field is computed on the server and read straight off the stored row, so no
  // component derives any of it. All `null` on a never-polled row.

  /** The lowest level that files a bug; `null` = every level (the default). */
  minimumLevel: string | null;
  /** When a poll last RAN, as ISO — successful or not. */
  lastPolledAt: string | null;
  /** The last poll's outcome; `null` = never polled. */
  lastPollStatus: 'ok' | 'failed' | null;
  /** Why the last poll failed, in words a person can act on. */
  lastPollError: string | null;
  /** How many bugs the last successful poll filed. */
  lastPollFiledCount: number | null;
  /** When a poll last came back `ok`, as ISO — so a FAILING row can still say
   *  when it last worked (the design delta, MOTIR-5575 §12). */
  lastPollSucceededAt: string | null;

  // ── SYNC STATE (Story MOTIR-4931) ─────────────────────────────────────────────
  // The two direction switches and the most recent FAILED resolve-back, read
  // straight off the stored row (Subtask MOTIR-5706). No component derives any
  // of it.

  /** Motir → monitor: resolve the linked issue when its bug is done. */
  resolveOnDone: boolean;
  /** Monitor → Motir: take a provider-side assignment onto the bug. */
  syncAssignee: boolean;
  /** The provider's own words for the last failed resolve-back, unaltered;
   *  `null` = nothing has failed since the last success. */
  lastSyncError: string | null;
  /** When that failure happened, as ISO. */
  lastSyncErrorAt: string | null;
  /** The `KEY-<n>` of the bug whose resolve failed, so the room can link it. */
  lastSyncErrorWorkItemIdentifier: string | null;
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
  /** When the grant's health was last established (a refresh or a probe), as
   *  ISO. On the VIEW rather than only on each row because the room says
   *  "checked N minutes ago" on a grant with NO rows yet (design panel 1b), and a
   *  value read off `connections[0]` does not exist there. */
  healthCheckedAt: string | null;
  connections: MonitorConnectionDto[];
}

/** Set either direction switch (MOTIR-5706). Sparse: an omitted key is left
 *  unchanged, and at least one must be present. */
export interface SetMonitorSyncDirectionsInput {
  resolveOnDone?: boolean;
  syncAssignee?: boolean;
}

/** Change one binding's minimum level (MOTIR-5579). `null` = every level. */
export interface SetMonitorMinimumLevelInput {
  minimumLevel: string | null;
}

/** Bind one monitored project to this Motir project. */
export interface BindMonitorProjectInput {
  externalProjectId: string;
  externalProjectSlug: string;
}
