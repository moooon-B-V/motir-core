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
 * The most frames {@link NormalizedMonitorIssueContext.frames} ever carries
 * (Story MOTIR-4930 · Subtask MOTIR-5846). A deep trace is dozens of framework
 * frames around a handful of the application's own; the adapter orders the
 * application's first and cuts here, so a consumer's prompt is bounded by a
 * number it can read rather than by whatever the runtime's stack depth was.
 */
export const MONITOR_ISSUE_FRAMES_MAX = 20;

/**
 * One frame of the error's stack, as the monitor reported it (MOTIR-5846).
 *
 * `filePath` is the only required field — a frame that names no file cannot
 * point anybody anywhere, so the adapter drops it rather than inventing one.
 * The other three are `null` wherever the event does not state them, in the
 * same register as the context's `environment` and `release`: a minified or
 * native frame routinely has no line, and `null` is the honest answer rather
 * than a guess. `inApp` is the MONITOR's own verdict on whether the frame is
 * the application's code rather than a library's; it is passed through, never
 * re-derived from the path.
 */
export interface NormalizedMonitorStackFrame {
  filePath: string;
  function: string | null;
  lineNumber: number | null;
  inApp: boolean | null;
}

/** The longest exception MESSAGE the context carries, in characters (Story
 *  MOTIR-5975 · Subtask MOTIR-5977). A longer one is cut and ends in `…`, so a
 *  reader always knows it was cut — never silently. */
export const MONITOR_EVIDENCE_MESSAGE_MAX = 4000;

/** The most TAGS the context carries — after the user-identifying ones are
 *  dropped, in the order the event states them (MOTIR-5977). */
export const MONITOR_EVIDENCE_TAGS_MAX = 30;

/** The longest tag VALUE the context carries, in characters (MOTIR-5977). */
export const MONITOR_EVIDENCE_TAG_VALUE_MAX = 200;

/** The longest request PATH the context carries, in characters (MOTIR-5977). */
export const MONITOR_EVIDENCE_PATH_MAX = 500;

/** The exception that SURFACED on the latest event (MOTIR-5977): its type
 *  (`PrismaClientKnownRequestError`) and its full message, bounded by
 *  {@link MONITOR_EVIDENCE_MESSAGE_MAX}. Either is `null` where the event does
 *  not state it. */
export interface NormalizedMonitorException {
  type: string | null;
  message: string | null;
}

/** One tag of the latest event, AFTER the user-identifying filter
 *  (`lib/monitors/evidence.ts`) has run. */
export interface NormalizedMonitorTag {
  key: string;
  value: string;
}

/** The request that triggered the latest event (MOTIR-5977): its method and its
 *  PATH ONLY. No scheme, host, query string, fragment, header, cookie or body is
 *  ever read, so none can be carried. */
export interface NormalizedMonitorRequest {
  method: string | null;
  path: string;
}

/**
 * What an issue's LATEST EVENT says that its LIST row does not carry (Story
 * MOTIR-4932 · Subtask MOTIR-5728, frames added by MOTIR-4930 · MOTIR-5846, the
 * rest of the EVIDENCE by MOTIR-5975 · MOTIR-5977): where it is happening, in
 * which build, where in the code it was thrown, what it said, what request
 * triggered it, and which event it was. Sentry keeps all of it on the event, so
 * it is read one issue at a time — in ONE request.
 *
 * `environment` / `release` are `null` when the latest event carries none — an
 * event with no release is ordinary, and `null` is the honest answer rather
 * than a guess. `frames` is `[]` by the same rule when the event carries no
 * exception stack: ordered in-app first, then most-recent call first, and never
 * longer than {@link MONITOR_ISSUE_FRAMES_MAX}. `exception` and `request` are
 * `null` when the event has no such entry; `tags` is `[]` when it has none left
 * after the filter; `eventId` / `eventAt` are `null` when absent or malformed.
 *
 * ⚠️ USER-IDENTIFYING DATA NEVER LEAVES THE SEAM. `tags` has already been
 * through `filterEvidenceTags` and `request.path` through `requestPathOf`, in
 * EVERY adapter, so no consumer can store or show what this returns without the
 * filter having run.
 *
 * ⚠️ WHAT IS STORED, AND WHERE: every SUCCESSFUL read — the reconcile visit
 * and the hand-made link — stores ALL of it on the `monitor_issue` link:
 * `environment` / `release` (MOTIR-5729) and the evidence, frames included
 * (MOTIR-5979), unless the link already holds a newer event. The work-item
 * page, `get_work_item` and the dispatch prompt read the STORE, never this call;
 * the bug enrichment (MOTIR-5849) still reads the frames here, at the moment it
 * needs them.
 */
export interface NormalizedMonitorIssueContext {
  environment: string | null;
  release: string | null;
  frames: NormalizedMonitorStackFrame[];
  exception: NormalizedMonitorException | null;
  tags: NormalizedMonitorTag[];
  request: NormalizedMonitorRequest | null;
  eventId: string | null;
  eventAt: Date | null;
}
