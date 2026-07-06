// The issue-importer CONNECTOR SEAM (Story 7.16 · MOTIR-1501).
//
// A connector's ONLY job is to read a source tracker (a live API or an uploaded
// file) and normalise it into the source-agnostic `SourceIssue` shape below. The
// downstream mapping / dry-run / persist stages (MOTIR-1504 / MOTIR-941) see ONLY
// `SourceIssue` — never a Jira / Linear / GitHub / Plane / CSV payload — so a
// further source is a NEW connector class, not a change to the pipeline (the ADR
// `docs/decisions/issue-importer.md` §1 "interface, not a per-source wizard
// branch").
//
// Connectors hit external APIs / files ONLY — they never touch the DB (that is
// the persist engine, MOTIR-941). Nothing here imports Prisma or `lib/db`.

/** The five import sources (mirrors the Prisma `ImportSource` enum values, kept
 *  as a local union so the pure connector layer does not couple to Prisma). */
export type SourceKind = 'jira' | 'linear' | 'github' | 'plane' | 'csv';

/** A comment on a source issue, normalised. Author is carried by BOTH email
 *  (for the resolver's email→member match) and display name (the fallback +
 *  the degraded-attribution line MOTIR-941 writes when no member matches). */
export interface SourceComment {
  authorEmail: string | null;
  authorName: string | null;
  body: string;
  /** ISO-8601 timestamp, or null when the source does not expose it. */
  createdAt: string | null;
}

/** A reference to a source attachment. The persist engine (MOTIR-941) fetches
 *  the bytes at `url` and re-uploads them where the source + scope allow. */
export interface SourceAttachmentRef {
  filename: string;
  url: string;
  contentType: string | null;
  byteSize: number | null;
}

/** A non-parent relationship between two source issues (Jira issuelink, Linear
 *  relation, …). `type` is the RAW source link type; the resolver (MOTIR-1504)
 *  maps it to a Motir relationship. */
export interface SourceLink {
  type: string;
  targetExternalId: string;
}

/**
 * The normalised, source-agnostic issue shape — the ONE internal model every
 * connector produces and every downstream stage consumes (ADR §1/§2). RAW
 * source tokens are carried for the classify fields (`type` / `status` /
 * `priority`): the connector does NOT decide the Motir kind / workflow_status /
 * priority — that is the mapping resolver's job (MOTIR-1504), which maps these
 * raw tokens against the user-confirmed mapping. A source that lacks a field
 * returns it empty (null / []), never throws — the per-source availability
 * matrix (ADR §2) degrades gracefully.
 */
export interface SourceIssue {
  /** The source's STABLE id — Jira `PROJ-123`, Linear identifier, GitHub
   *  `owner/repo#42`, the Plane work-item UUID, a CSV id column. This is the
   *  idempotency key `(source, externalId)` (ADR §3); it MUST be stable across
   *  re-runs, never a renameable display ref. */
  externalId: string;
  title: string;
  descriptionMd: string | null;
  /** RAW source issue-type token (e.g. "Bug", "Story") — mapped to a Motir
   *  `kind` by the resolver. */
  type: string | null;
  /** RAW source status token (e.g. "In Progress", "Done", "closed") — mapped to
   *  a project `workflow_status` by the resolver, INCLUDING done-category
   *  statuses (closed issues are in scope, ADR Context). */
  status: string | null;
  /** RAW source priority token — mapped to `lowest|low|medium|high|highest`
   *  (unmatched → `medium`, ADR §2). */
  priority: string | null;
  assigneeEmail: string | null;
  assigneeName: string | null;
  reporterEmail: string | null;
  reporterName: string | null;
  labels: string[];
  comments: SourceComment[];
  attachments: SourceAttachmentRef[];
  /** The source parent's `externalId`, or null. Resolved to a Motir parent edge
   *  in a SECOND pass (a parent may import after its child) — MOTIR-941. */
  parentExternalId: string | null;
  links: SourceLink[];
  /** ISO-8601 created timestamp, or null. */
  createdAt: string | null;
  /** ISO-8601 closed/resolved timestamp, or null when still open. */
  closedAt: string | null;
}

/** The result of `connect()` — proof the source is reachable + a human-facing
 *  ref + an optional total (null when a count is unknown or expensive). */
export interface ConnectResult {
  source: SourceKind;
  /** The connected project / repo / file ref (Jira project key, GitHub
   *  `owner/repo`, the uploaded filename). Stored on `Import.sourceRef`. */
  sourceRef: string;
  /** Total issue count if cheaply known, else null (the connector pages). */
  issueCount: number | null;
}

/** The source's field vocabulary the wizard's mapping step renders — the
 *  distinct values the user maps to Motir kinds / statuses / priorities /
 *  labels. A source that derives a field from labels returns it empty. */
export interface SourceFieldVocabulary {
  types: string[];
  statuses: string[];
  priorities: string[];
  labels: string[];
}

/** A per-issue (or per-row) error — collected, NOT fatal. A single bad issue is
 *  surfaced in the preview, never aborts the whole page/run (ADR §1, the
 *  card's per-issue-error contract). */
export interface SourceIssueError {
  externalId: string | null;
  message: string;
}

/** ONE page of normalised issues + the cursor to fetch the next page + any
 *  per-issue errors from this page. `nextCursor === null` means the last page. */
export interface SourceIssuePage {
  issues: SourceIssue[];
  nextCursor: string | null;
  errors: SourceIssueError[];
}

/**
 * The connector interface (ADR §1). Every source implements it; the pipeline is
 * source-agnostic behind it.
 *
 * - `connect()` — validate creds / parse the file; return the reachable source
 *   + an optional count. Throws a fatal {@link ConnectorError} on bad
 *   credentials / unreachable source / unparseable file.
 * - `discoverFields()` — the source's field vocabulary for the mapping step.
 * - `listIssues(cursor)` — ONE page of normalised issues + the next cursor.
 *   PAGINATED — never "fetch all into memory". Per-issue failures come back in
 *   `page.errors`; only a page-level failure (after retries) throws.
 */
export interface IssueSourceConnector {
  readonly source: SourceKind;
  connect(): Promise<ConnectResult>;
  discoverFields(): Promise<SourceFieldVocabulary>;
  listIssues(cursor?: string | null): Promise<SourceIssuePage>;
}
