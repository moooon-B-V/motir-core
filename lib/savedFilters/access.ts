import type { SavedFilterVisibility } from '@prisma/client';
import { canBrowse, canEdit, type ProjectAccessInputs } from '@/lib/projects/access';
import { isWorkspaceManager } from '@/lib/projects/roles';

// The saved-filter permission POLICY (Story 6.2 · Subtask 6.2.1) — pure
// decision functions composed FROM the shipped 6.4 project policy rather
// than a parallel decision table (the canCreateAttachments precedent). The
// project-level tier resolves ONCE per request into
// SavedFilterProjectCapabilities (via projectAccessService.
// getSavedFilterCapabilities — one resolveInputs round-trip, the
// getCommentCapabilities pattern); the per-row predicates below then decide
// over those three booleans plus the row's facts. The IO half (locking rows,
// asserting, 404-vs-403 mapping) lives in lib/services/savedFiltersService.ts.
//
// The matrix (mirror-verified in the Story 6.2 description, deviations
// recorded there):
//   * CREATE + STAR — anyone who can browse the project, INCLUDING the
//     read-only viewer persona: filters are a read-layer construct, so a
//     viewer creates/stars PRIVATE filters freely.
//   * SHARE (visibility `project`) — role ≥ member: publishing into the
//     project's shared namespace is a write, so the gate IS the shipped 6.4
//     edit tier (`canEdit` — viewers and non-members are read-only).
//   * SEE — visibility `project` → everyone who can browse; `private` → the
//     owner + the admin tier (Jira: "a private filter is visible to the
//     owner + Jira admins"). Not-visible reads as not-found (finding #44).
//   * MANAGE (update / delete) — the owner always manages their own; the
//     admin tier manages any PROJECT-SHARED filter (the mirror's "admins can
//     change owner / delete any shared filter", project-sized). An admin
//     does NOT manage another user's private filter — they can see it, not
//     rewrite it.
//   * CHANGE OWNER — admin tier only, on project-shared filters.

/** The actor's project-level tier for this domain — resolved once per
 * request (projectAccessService.getSavedFilterCapabilities). */
export interface SavedFilterProjectCapabilities {
  canBrowse: boolean;
  /** Role ≥ member — may publish at visibility `project`. */
  canShare: boolean;
  /** Project admin or workspace owner/admin — sees every row, manages the
   * shared ones. */
  isAdmin: boolean;
}

/** The pure half of getSavedFilterCapabilities — exported so the service
 * can compute the tier from already-resolved inputs and the matrix tests
 * can drive it directly. */
export function savedFilterCapabilities(i: ProjectAccessInputs): SavedFilterProjectCapabilities {
  const admin =
    isWorkspaceManager(i.workspaceRole) || (i.workspaceRole != null && i.projectRole === 'admin');
  return { canBrowse: canBrowse(i), canShare: canEdit(i), isAdmin: admin };
}

/** Per-row facts the row-level predicates decide over. */
export interface SavedFilterRowFacts {
  isOwner: boolean;
  visibility: SavedFilterVisibility;
}

/** Whether the actor may CREATE a saved filter at `visibility` (also the
 * gate for flipping an existing filter TO that visibility). */
export function canCreateSavedFilter(
  caps: SavedFilterProjectCapabilities,
  visibility: SavedFilterVisibility,
): boolean {
  return visibility === 'project' ? caps.canShare : caps.canBrowse;
}

/** Whether the actor may SEE the filter at all (every read path — list,
 * resolve, dependents — applies this; a miss reads as not-found). */
export function canSeeSavedFilter(
  caps: SavedFilterProjectCapabilities,
  row: SavedFilterRowFacts,
): boolean {
  if (!caps.canBrowse) return false;
  if (row.visibility === 'project') return true;
  return row.isOwner || caps.isAdmin;
}

/** Whether the actor may UPDATE (rename / edit details / overwrite criteria /
 * flip visibility) or DELETE the filter. */
export function canManageSavedFilter(
  caps: SavedFilterProjectCapabilities,
  row: SavedFilterRowFacts,
): boolean {
  if (!canSeeSavedFilter(caps, row)) return false;
  if (row.isOwner) return true;
  return row.visibility === 'project' && caps.isAdmin;
}

/** Whether the actor may CHANGE THE OWNER — admin tier only, on shared
 * filters (the mirror's admin power; an owner hands off by sharing first). */
export function canChangeSavedFilterOwner(
  caps: SavedFilterProjectCapabilities,
  row: SavedFilterRowFacts,
): boolean {
  return row.visibility === 'project' && caps.isAdmin;
}
