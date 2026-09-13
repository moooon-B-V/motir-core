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
}

/** A page of issues plus the cursor to resume from — the poll's own bookkeeping,
 *  which MOTIR-4929 stores and this seam never does. */
export interface NormalizedMonitorIssuePage {
  issues: NormalizedMonitorIssue[];
  /** The cursor for the NEXT page, or null when this page is the last. */
  nextCursor: string | null;
}
