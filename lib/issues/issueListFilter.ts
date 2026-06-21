// The /items FILTER URL contract (Subtask 2.5.4). The `[Filter]` bar narrows
// the issue tree (and the flat List) by four facets — kind · status · assignee ·
// text — and, like the view + sort (issueListView.ts), the whole filter lives in
// the URL: shareable, bookmarkable, reload-safe, and the SAME serialization
// Epic 6's saved filters will persist. This module is the single, UI-free source
// of truth for parsing + serializing those params and mapping them to the
// service read filter, so the Server Component (read side), the client filter
// bar, the view switcher, and the List sort headers all agree. Kept pure (no
// React, no Prisma) → unit-tested in isolation.
//
// MULTI-SELECT (mirror product: Jira basic filters; the 2.5.4 design draws
// several kinds/statuses/assignees selected at once). Each facet is a SET, so
// the params REPEAT: `?kind=bug&kind=task&status=todo&assignee=<id>&assignee=
// unassigned&q=oauth`. The literal `assignee=unassigned` token is the
// "Unassigned" bucket (items with no assignee), OR-ed with the explicit member
// ids. `q` is the single text quick-filter.

import type { ProjectTreeFilter, WorkItemTypeDto } from '@/lib/dto/workItems';
import { ISSUE_TYPES, isIssueType, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES, isWorkItemType } from '@/lib/issues/executorDefaults';

/** The literal assignee token for the "Unassigned" bucket (no assignee). */
export const UNASSIGNED_TOKEN = 'unassigned';

/** The literal work-type token for the "Untyped" bucket (a null `type` — epics,
 * stories, and legacy rows). The registry's `type` field is NULLABLE but carries
 * a closed `valueWhitelist`, so — unlike assignee's sentinel — this token lives
 * ONLY in the facet URL param; the facet→AST map (`facetFilterToAst`) expresses
 * it as the `is_empty` operator instead (no registry sentinel). */
export const UNTYPED_TOKEN = 'untyped';

/**
 * The parsed, client-facing filter state. Facet axes are non-optional arrays
 * (empty = "don't filter on this axis") so the client renders without
 * null-checks; `text` is null when absent. `kinds` is held in canonical
 * issue-type order, `statuses` / `assigneeIds` sorted, so a given selection
 * always serializes to ONE canonical URL (stable shares + deterministic tests).
 */
export interface IssueFilter {
  kinds: IssueType[];
  /**
   * The work-item TYPE facet (Story 2.7 · the 6.15 quick-filter facet) — the
   * `WorkItemType` members selected, held in canonical `WORK_ITEM_TYPES` order
   * (one canonical URL per selection). `includeUntyped` is the OR-ed null bucket
   * (epics/stories/legacy rows with `type = null`), mirroring how
   * `includeUnassigned` rides the assignee facet.
   */
  types: WorkItemTypeDto[];
  /** Include items with NO work type (the "Untyped" bucket), OR-ed with `types`. */
  includeUntyped: boolean;
  statuses: string[];
  assigneeIds: string[];
  includeUnassigned: boolean;
  text: string | null;
  /**
   * The advanced filter builder's `?filter=v1:…` param value (Story 6.1 ·
   * Subtask 6.1.4), carried RAW (still encoded) and OPAQUE at this layer so
   * every control that round-trips the filter through `buildIssueListHref`
   * (view switcher, sort headers, pager, the facet bar itself) preserves the
   * active builder state without knowing its shape. Decoding + validation is
   * `lib/issues/issueListAdvancedFilter.ts`'s job at the page boundary — an
   * INVALID param is nulled there before threading, so a broken link never
   * propagates through navigation. `null` = no advanced filter.
   */
  advanced: string | null;
}

/** The no-filter state — the full, unpruned tree. */
export const EMPTY_FILTER: IssueFilter = {
  kinds: [],
  types: [],
  includeUntyped: false,
  statuses: [],
  assigneeIds: [],
  includeUnassigned: false,
  text: null,
  advanced: null,
};

/** Next.js hands each searchParams key as `string | string[] | undefined`. */
export type RawParam = string | string[] | undefined;

/** The filter slice of the `/items` searchParams. */
export interface IssueFilterParams {
  kind?: RawParam;
  type?: RawParam;
  status?: RawParam;
  assignee?: RawParam;
  q?: RawParam;
  /** The advanced builder's versioned AST param (Subtask 6.1.4). */
  filter?: RawParam;
}

function toList(raw: RawParam): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((v) => v.length > 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Parse the filter slice of the URL into a validated {@link IssueFilter}.
 * `kind` values are whitelisted to real issue types (an unknown kind is
 * dropped — the read maps straight to SQL); `status` / `assignee` are kept as
 * opaque keys/ids (an unknown one simply matches nothing, which is safe). The
 * `assignee=unassigned` token sets `includeUnassigned`; a blank `q` is null.
 * Output axes are canonically ordered so the round-trip is stable.
 */
export function parseIssueFilter(params: IssueFilterParams): IssueFilter {
  const kinds = dedupe(toList(params.kind))
    .filter((k): k is IssueType => isIssueType(k))
    .sort((a, b) => ISSUE_TYPES.indexOf(a) - ISSUE_TYPES.indexOf(b));
  const typeRaw = toList(params.type);
  const includeUntyped = typeRaw.includes(UNTYPED_TOKEN);
  const types = dedupe(typeRaw.filter((t) => t !== UNTYPED_TOKEN))
    .filter((t): t is WorkItemTypeDto => isWorkItemType(t))
    .sort((a, b) => WORK_ITEM_TYPES.indexOf(a) - WORK_ITEM_TYPES.indexOf(b));
  const statuses = dedupe(toList(params.status)).sort();
  const assigneeRaw = toList(params.assignee);
  const includeUnassigned = assigneeRaw.includes(UNASSIGNED_TOKEN);
  const assigneeIds = dedupe(assigneeRaw.filter((a) => a !== UNASSIGNED_TOKEN)).sort();
  const text = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? '';
  const advanced = (Array.isArray(params.filter) ? params.filter[0] : params.filter)?.trim() ?? '';
  return {
    kinds,
    types,
    includeUntyped,
    statuses,
    assigneeIds,
    includeUnassigned,
    text: text.length > 0 ? text : null,
    advanced: advanced.length > 0 ? advanced : null,
  };
}

/** True when at least one FACET is constraining the result. Deliberately
 * blind to `advanced` — the facet bar's active ring/badge and the builder's
 * are separate controls (the Advanced trigger owns its own count); read-path
 * "is anything filtering?" checks OR this with the decoded AST. */
export function isFilterActive(f: IssueFilter): boolean {
  return (
    f.kinds.length > 0 ||
    f.types.length > 0 ||
    f.includeUntyped ||
    f.statuses.length > 0 ||
    f.assigneeIds.length > 0 ||
    f.includeUnassigned ||
    f.text !== null
  );
}

/**
 * The number of active filter VALUES — each selected kind / status / assignee
 * (incl. "Unassigned") counts 1, plus 1 for a non-empty text. This is the count
 * the trigger badge shows (matches the 2.5.4 design).
 */
export function countActiveFilters(f: IssueFilter): number {
  return (
    f.kinds.length +
    f.types.length +
    (f.includeUntyped ? 1 : 0) +
    f.statuses.length +
    f.assigneeIds.length +
    (f.includeUnassigned ? 1 : 0) +
    (f.text !== null ? 1 : 0)
  );
}

/**
 * Append the filter facets to a `URLSearchParams` (used by `buildIssueListHref`
 * so the view switcher + List sort headers preserve the active filter). Facets
 * repeat in canonical order; `q` is a single value. Nothing is appended for an
 * empty facet, so the no-filter URL stays clean.
 */
export function appendFilterParams(params: URLSearchParams, f: IssueFilter): void {
  for (const k of f.kinds) params.append('kind', k);
  for (const t of f.types) params.append('type', t);
  if (f.includeUntyped) params.append('type', UNTYPED_TOKEN);
  for (const s of f.statuses) params.append('status', s);
  for (const a of f.assigneeIds) params.append('assignee', a);
  if (f.includeUnassigned) params.append('assignee', UNASSIGNED_TOKEN);
  if (f.text !== null) params.set('q', f.text);
  if (f.advanced !== null) params.set('filter', f.advanced);
}

/**
 * Map the URL/client filter → the service read DTO ({@link ProjectTreeFilter}),
 * omitting every empty axis (so an all-empty filter is `{}` → the full tree).
 */
export function toProjectTreeFilter(f: IssueFilter): ProjectTreeFilter {
  const out: ProjectTreeFilter = {};
  if (f.kinds.length > 0) out.kinds = f.kinds;
  if (f.types.length > 0) out.types = f.types;
  if (f.includeUntyped) out.includeUntyped = true;
  if (f.statuses.length > 0) out.statuses = f.statuses;
  if (f.assigneeIds.length > 0) out.assigneeIds = f.assigneeIds;
  if (f.includeUnassigned) out.includeUnassigned = true;
  if (f.text !== null) out.text = f.text;
  return out;
}

// --- immutable single-facet toggles (the client filter bar's edit ops) -------

/** Toggle a kind in/out of the filter. */
export function toggleKind(f: IssueFilter, kind: IssueType): IssueFilter {
  const has = f.kinds.includes(kind);
  const kinds = (has ? f.kinds.filter((k) => k !== kind) : [...f.kinds, kind]).sort(
    (a, b) => ISSUE_TYPES.indexOf(a) - ISSUE_TYPES.indexOf(b),
  );
  return { ...f, kinds };
}

/** Toggle a work type in/out of the filter (canonical `WORK_ITEM_TYPES` order). */
export function toggleType(f: IssueFilter, type: WorkItemTypeDto): IssueFilter {
  const has = f.types.includes(type);
  const types = (has ? f.types.filter((t) => t !== type) : [...f.types, type]).sort(
    (a, b) => WORK_ITEM_TYPES.indexOf(a) - WORK_ITEM_TYPES.indexOf(b),
  );
  return { ...f, types };
}

/** Toggle the "Untyped" bucket. */
export function toggleUntyped(f: IssueFilter): IssueFilter {
  return { ...f, includeUntyped: !f.includeUntyped };
}

/** Toggle a status key in/out of the filter. */
export function toggleStatus(f: IssueFilter, statusKey: string): IssueFilter {
  const has = f.statuses.includes(statusKey);
  const statuses = (
    has ? f.statuses.filter((s) => s !== statusKey) : [...f.statuses, statusKey]
  ).sort();
  return { ...f, statuses };
}

/** Toggle a member id in/out of the assignee facet. */
export function toggleAssignee(f: IssueFilter, userId: string): IssueFilter {
  const has = f.assigneeIds.includes(userId);
  const assigneeIds = (
    has ? f.assigneeIds.filter((a) => a !== userId) : [...f.assigneeIds, userId]
  ).sort();
  return { ...f, assigneeIds };
}

/** Toggle the "Unassigned" bucket. */
export function toggleUnassigned(f: IssueFilter): IssueFilter {
  return { ...f, includeUnassigned: !f.includeUnassigned };
}

/** Set (or clear, with a blank string) the text quick-filter. */
export function setFilterText(f: IssueFilter, text: string): IssueFilter {
  const trimmed = text.trim();
  return { ...f, text: trimmed.length > 0 ? trimmed : null };
}
