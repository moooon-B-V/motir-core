// The importer ENGINE types (Story 7.16 · MOTIR-1504) — the pure, write-free
// half: the user-confirmed mapping config, the resolve context, the resolved
// work-item payload, and the classified plan row. The persist slice
// (MOTIR-941) consumes these SAME shapes with writes enabled, so the real run
// can never diverge from the preview.

import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { SourceAttachmentRef, SourceLink } from '../connectors/types';

/** What happens to an unmatched assignee/reporter (ADR §2 unmatched-user
 *  policy — surfaced as a wizard choice, resolved here). */
export type UnmatchedUserPolicy = 'unassign' | 'importing_user' | 'invite';

/**
 * The user-confirmed field mapping (7.16.2), stored as `Import.mapping` JSON and
 * applied per issue. Every entry is optional so a minimal mapping still runs;
 * token matches are case-insensitive.
 */
export interface ImportMapping {
  /** Source issue-type token → Motir kind. */
  typeToKind?: Record<string, WorkItemKindDto>;
  /** Fallback kind when the source type is absent/unmapped (default `task`). */
  defaultKind?: WorkItemKindDto;
  /** Source status token → a project `workflow_status` key. */
  statusToKey?: Record<string, string>;
  /** Fallback status key for an unmapped status (else the project's initial). */
  defaultStatusKey?: string | null;
  /** Source priority token → Motir priority. */
  priorityToPriority?: Record<string, WorkItemPriorityDto>;
  /** What to do with an unmatched assignee/reporter (default `unassign`). */
  unmatchedUserPolicy?: UnmatchedUserPolicy;
}

/** The per-run, project-scoped context the resolver reads (built ONCE per run
 *  by the engine service from the project's workflow + workspace members). */
export interface ImportResolveContext {
  projectId: string;
  workspaceId: string;
  importingUserId: string;
  /** The project's valid `workflow_status` keys. */
  statusKeys: Set<string>;
  /** The project's initial status key (the create lands here; the mapped
   *  status is applied via the transition path in MOTIR-941). */
  initialStatusKey: string | null;
  /** Lowercased member email → userId (assignee/reporter/comment-author match). */
  membersByEmail: Map<string, string>;
}

/** A source comment with its author resolved to a member id where one matches. */
export interface ResolvedComment {
  authorId: string | null;
  authorEmail: string | null;
  authorName: string | null;
  body: string;
  createdAt: string | null;
}

/**
 * The fully-resolved Motir work-item payload for one source issue — pure data,
 * no persistence. `statusKey` and `reporterId`/`reporterEmail` and
 * `parentExternalId` are carried for MOTIR-941's in-authority extensions
 * (status via the transition path; reporter preservation; parent 2nd pass).
 */
export interface ResolvedWorkItemPayload {
  kind: WorkItemKindDto;
  title: string;
  descriptionMd: string | null;
  priority: WorkItemPriorityDto;
  /** The resolved workflow_status key (applied via the transition path, 941). */
  statusKey: string;
  assigneeId: string | null;
  /** Resolved reporter member id (else null → importing user, 941). */
  reporterId: string | null;
  /** The source reporter's email (for the preservation extension / attribution). */
  reporterEmail: string | null;
  labels: string[];
  comments: ResolvedComment[];
  attachments: SourceAttachmentRef[];
  /** Resolved to a Motir parent id in the 2nd pass (941). */
  parentExternalId: string | null;
  links: SourceLink[];
  createdAt: string | null;
  closedAt: string | null;
}

/** The idempotency classification (ADR §3). */
export type ImportPlan = 'create' | 'update' | 'skip';

/** One issue's dry-run plan row — the CREATE/UPDATE/SKIP verdict + the resolved
 *  payload + any warnings + the source hash + the existing work item (on
 *  update/skip). What the wizard's preview renders; what the run consumes. */
export interface ImportPlanRow {
  externalId: string;
  plan: ImportPlan;
  payload: ResolvedWorkItemPayload;
  warnings: string[];
  sourceHash: string;
  /** The mapped work item on UPDATE/SKIP, else null. */
  existingWorkItemId: string | null;
}
