import type { FilterAst, FilterDecodeResult } from '@/lib/filters/ast';

// Saved-filter DTOs (Story 6.2 · Subtask 6.2.1) — the wire shapes the routes
// return and the 6.2.3/6.2.4 surfaces (and the Story 6.3 data-source
// consumers) read. Prisma-free.

/** One persisted saved filter, as the list/detail reads return it. */
export interface SavedFilterSummaryDto {
  id: string;
  name: string;
  description: string | null;
  visibility: 'private' | 'project';
  owner: { id: string; name: string };
  /** SQL-aggregated star count (the directory's popularity column). */
  starCount: number;
  /** Whether the CURRENT actor starred it (drives the dropdown's starred
   * group + the in-place toggle). */
  starredByMe: boolean;
  builtin: false;
  updatedAt: string;
}

/** One built-in default ("system") filter — non-persisted, read-only. */
export interface BuiltinFilterSummaryDto {
  /** `builtin:<slug>` — rides the same resolve read as row ids. */
  id: string;
  name: string;
  builtin: true;
}

/** A cursor page of saved filters (the backlog CursoredPage shape) plus the
 * built-in defaults (constants — never paginated; filtered by `q` so the
 * dropdown search covers them too). */
export interface SavedFilterPageDto {
  items: SavedFilterSummaryDto[];
  nextCursor: string | null;
  total: number;
  builtins: BuiltinFilterSummaryDto[];
}

/** The typed recoverable degraded state a stored envelope can resolve to
 * (malformed / future-versioned / registry-invalid — never a crash). */
export type SavedFilterAstError = Extract<FilterDecodeResult, { ok: false }>;

/** What the actor may DO with the resolved filter — drives the 6.2.3
 * owner-vs-non-owner Save split and the 6.2.4 row actions. */
export interface SavedFilterCapabilitiesDto {
  /** Overwrite-save criteria / rename / edit details / flip visibility. */
  canManage: boolean;
  canDelete: boolean;
  canChangeOwner: boolean;
  /** Whether a save dialog may offer the Project visibility option. */
  canShare: boolean;
}

/**
 * THE Story 6.3 data-source contract (also the 6.2.3 apply read): a filter id
 * resolved to its decoded + registry-validated AST. `ast` is null exactly
 * when `astError` is set — the typed degraded state a consumer renders as the
 * designed "filter broken/missing" card. A non-null `ast` is guaranteed
 * registry-valid; consumers feed it to the work-item read paths
 * (`workItemRepository` compiles it, re-validating in depth — stale open
 * referents inside it match nothing per the 6.1.2 rule).
 */
export interface ResolvedSavedFilterDto {
  filter: SavedFilterSummaryDto | BuiltinFilterSummaryDto;
  ast: FilterAst | null;
  astError: SavedFilterAstError | null;
  capabilities: SavedFilterCapabilitiesDto;
}

/**
 * The delete-impact enumeration behind the Cloud-style warning dialog
 * ("N subscriptions will be removed · N dashboard widgets will lose this
 * filter"). Subscriptions land in 6.2.5 (their table FK-cascades off
 * `saved_filter`); `widgetCount` (Subtask 6.3.1) counts the dashboard
 * widgets whose `saved_filter_id` FK the delete would SetNull — those
 * widgets go STALE (the designed "filter missing" card), never away.
 */
export interface SavedFilterDependentsDto {
  subscriptionCount: number;
  widgetCount: number;
}
