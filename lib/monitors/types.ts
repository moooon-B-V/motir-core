// The NORMALIZED value types every error monitor is described in (Story
// MOTIR-4926 · MOTIR-5259). Mirrors `lib/git/types.ts`: no field here names a
// Sentry concept, so a consumer holds no host-specific type and a second
// provider is "implement the interface + register it" rather than a change in
// every caller.

/** The provider discriminator stored on `monitor_installation.provider`. */
export type MonitorProviderId = 'sentry' | 'fake';

/**
 * A credential issued by a provider's authorisation — what Motir persists,
 * encrypted, on the grant.
 *
 * `expiresAt` is ABSOLUTE rather than a TTL, deliberately: a duration has to be
 * added to "now" by whoever stores it, and two callers adding it at two moments
 * is how a refresh window drifts. The adapter does that arithmetic once, where
 * it also knows what the provider meant.
 */
export interface MonitorCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** A monitored project a person can bind — the provider's own id and slug, plus
 *  the name a picker shows. */
export interface NormalizedMonitorProject {
  externalId: string;
  slug: string;
  name: string;
}

/** A connection's health, as the PROVIDER reports it.
 *
 *  `reason` is the provider's OWN string and is passed through unaltered — the
 *  settings surface shows it to a person, and a re-worded reason is a reason
 *  nobody can act on. */
export interface NormalizedMonitorHealth {
  status: 'connected' | 'degraded';
  reason: string | null;
  checkedAt: Date;
}

/**
 * One issue from a monitor — the shape the INGESTION story (MOTIR-4929) turns
 * into a `bug` work item.
 *
 * `externalId` is the dedup key that story keys on; `culprit` and `permalink`
 * are what make a filed bug worth reading. Defined here rather than there
 * because the seam is defined once, against one real implementation.
 */
export interface NormalizedMonitorIssue {
  externalId: string;
  title: string;
  culprit: string | null;
  level: string | null;
  /** How many times the monitor has seen it. */
  eventCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  permalink: string | null;
  /**
   * Who the issue is assigned to IN THE MONITOR (Story MOTIR-4931 · Subtask
   * MOTIR-5702), or `null` when unassigned. The assignee sync (MOTIR-5705) maps a
   * `user` to a Motir member by email; a `team` is recorded and never applied.
   */
  assignee: NormalizedMonitorAssignee | null;
}

/** A monitor-side assignee. `externalId` is the provider's own id for the user
 *  or team — unique only WITHIN its `kind`, so a comparison keys on both.
 *  `email` is `null` for a team, or wherever the provider omits it. */
export interface NormalizedMonitorAssignee {
  kind: 'user' | 'team';
  externalId: string;
  email: string | null;
  name: string | null;
}

/** A page of issues plus the cursor to resume from — the poll's own bookkeeping,
 *  which MOTIR-4929 stores and this seam never does. */
export interface NormalizedMonitorIssuePage {
  issues: NormalizedMonitorIssue[];
  /** The cursor for the NEXT page, or null when this page is the last. */
  nextCursor: string | null;
}

/**
 * Two facts about an issue that its LIST row does not carry (Story MOTIR-4932 ·
 * Subtask MOTIR-5728): where it is happening and in which build. Sentry keeps
 * both on the issue's LATEST EVENT, so they are read one issue at a time.
 *
 * Either is `null` when the latest event carries none — an event with no
 * release is ordinary, and `null` is the honest answer rather than a guess.
 */
export interface NormalizedMonitorIssueContext {
  environment: string | null;
  release: string | null;
}
