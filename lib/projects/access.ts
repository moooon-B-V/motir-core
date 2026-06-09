import type { MemberRole, ProjectAccessLevel } from '@prisma/client';
import { isWorkspaceManager } from '@/lib/projects/roles';

// The project browse/edit access POLICY (Story 6.4 · Subtask 6.4.3) — a single,
// pure decision function over three inputs. Kept here (no Prisma client, no IO)
// so it is trivially unit-testable and importable from anywhere; the IO half
// (resolving the inputs from the DB, then asserting) lives in
// `lib/services/projectAccessService.ts`.
//
// The model mirrors Jira team-managed projects (decision-authority rung 1):
//   * accessLevel `open`    — any workspace member views + edits.
//   * accessLevel `limited` — any workspace member views + comments; only
//                             project members (member/admin) edit.
//   * accessLevel `private` — only project members (or workspace owner/admin)
//                             can see it at all; viewers see but can't edit.
//
// Two always-pass / always-deny rails frame every level:
//   * A workspace OWNER or ADMIN always passes BOTH browse and edit — the
//     "site admin sees + manages every project" tier (isWorkspaceManager).
//   * A non-workspace-member (workspaceRole == null) always fails BOTH — the
//     project gate sits BENEATH the workspace gate (finding #26), so someone
//     outside the workspace never reaches a project in it.
//
// Between those rails, the per-level table applies. A project role of `viewer`
// is read-only EVERYWHERE (the global "viewer can view + comment, never edit"
// rule), so it is denied edit before the per-level branch.

/** The resolved facts the policy decides over (no IO — see projectAccessService). */
export interface ProjectAccessInputs {
  /** The project's `accessLevel` (open / limited / private). */
  accessLevel: ProjectAccessLevel;
  /** The actor's WORKSPACE membership role, or null if they're not a member. */
  workspaceRole: MemberRole | null;
  /** The actor's PROJECT membership role, or null if they hold no project membership. */
  projectRole: MemberRole | null;
}

/**
 * Whether the actor may BROWSE (view) the project — its read paths (the project
 * read, the board projection, the issue list/detail). `open`/`limited` admit any
 * workspace member; `private` requires an explicit project membership. Workspace
 * owner/admin always pass; a non-workspace-member never does.
 */
export function canBrowse(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  switch (i.accessLevel) {
    case 'open':
    case 'limited':
      return true;
    case 'private':
      return i.projectRole != null;
  }
}

/**
 * Whether the actor may EDIT the project's issues/board (create / move / assign /
 * update). Workspace owner/admin always pass; a non-workspace-member never does;
 * an explicit project `viewer` is read-only everywhere. Then per level:
 *   * `open`    — any workspace member edits.
 *   * `limited` — only project members with role member/admin edit (everyone
 *                 else is view + comment).
 *   * `private` — only project members with role member/admin edit (browse has
 *                 already ensured they're a member; a viewer was denied above).
 */
export function canEdit(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  if (i.projectRole === 'viewer') return false;
  switch (i.accessLevel) {
    case 'open':
      return true;
    case 'limited':
    case 'private':
      return i.projectRole === 'member' || i.projectRole === 'admin';
  }
}
