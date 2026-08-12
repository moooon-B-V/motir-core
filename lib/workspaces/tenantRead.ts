import type { Prisma, Project, WorkItem } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The tenant-table read that OPENS a service — always context-bound.
//
// MOTIR-2569, the sibling of `lib/workspaces/membershipGate.ts` one layer down
// (`docs/rls-runtime-role-inventory.md` Finding 4). MOTIR-2527 fixed the membership
// gates; this fixes the reads that run BEFORE them.
//
// `project` and `work_item` carry workspace-keyed RLS policies of their own —
// `project_workspace_or_system_read` and `work_item_active_workspace`, both keyed on
// the per-TRANSACTION `app.workspace_id` GUC. A service that opens with a `db`-singleton
// `findById` binds nothing, the policy compares against NULL, the row is invisible, and
// the method throws `ProjectNotFoundError` / `WorkItemNotFoundError` **before any access
// gate is consulted**. Same failure mode as Finding 1 and just as dishonest: no RLS
// denial is logged, because there is no denial — the query succeeded and returned zero
// rows, and the caller is told the project does not exist.
//
// It was invisible until MOTIR-2527 landed, because the membership gate was the FIRST
// unbound read on essentially every path and consumed the failure. That is the shape to
// expect from here on: each layer repaired reveals the next, and the honest completion
// signal is a NAMED error class reaching zero, never the total failure count falling.
//
// So the services do not choose a client for these reads any more — they call one of the
// readers below, and the binding is a property of the reader, not of the call site.
//
// ⚠️ These bind `ctx.workspaceId`, so under the non-bypass role a project or item in
// ANOTHER workspace is simply not returned. That is the same 404-not-403 posture the
// callers already enforce in application code (`project.workspaceId !== ctx.workspaceId`
// → `ProjectNotFoundError`, finding #26), and the explicit check MUST STAY: under a
// BYPASSRLS role — which is what CI runs today and what production runs until
// MOTIR-2515 — RLS is inert and the row comes back. Deleting the check because "RLS
// handles it" would split the behaviour by role, which is precisely what this chain
// exists to remove.

/** The minimal actor context these reads bind — satisfied by `ServiceContext` alike. */
export interface TenantReadContext {
  userId: string;
  workspaceId: string;
}

/**
 * A project by id, read inside a transaction that binds the GUCs the
 * `project_workspace_or_system_read` policy reads.
 *
 * Pass `tx` when the caller is ALREADY inside a context-bound transaction (a
 * `withWorkspaceContext` body) — the read then shares that snapshot and its GUCs.
 * **Do not pass a transaction that binds no GUCs** (a bare `db.$transaction`): the read
 * would see NULL context and return the same false miss this function exists to remove.
 * Omit `tx` there and let this open its own bound one.
 */
export async function readProject(
  projectId: string,
  ctx: TenantReadContext,
  tx?: Prisma.TransactionClient,
): Promise<Project | null> {
  if (tx) return projectRepository.findById(projectId, tx);
  return withWorkspaceContext(ctx, (t) => projectRepository.findById(projectId, t));
}

/**
 * The same read addressed by the project's workspace-unique `identifier` (the `PROD`-style
 * key). The lookup is already keyed on `(workspaceId, identifier)`, so it is inherently
 * workspace-scoped — the binding is what makes the ROW visible, not what scopes it.
 */
export async function readProjectByIdentifier(
  identifier: string,
  ctx: TenantReadContext,
  tx?: Prisma.TransactionClient,
): Promise<Project | null> {
  if (tx) return projectRepository.findByIdentifier(ctx.workspaceId, identifier, tx);
  return withWorkspaceContext(ctx, (t) =>
    projectRepository.findByIdentifier(ctx.workspaceId, identifier, t),
  );
}

/**
 * A work item by id, read inside a transaction that binds the GUCs
 * `work_item_active_workspace` reads.
 *
 * `withWorkspaceContext` binds `app.project_id` to the empty string when no project is
 * given, which is what the restrictive `work_item_project_narrow` policy's
 * `coalesce(...) = ''` branch wants: every project in the workspace stays visible. These
 * callers resolve an item BEFORE they know its project, so narrowing here would hide the
 * row they are about to gate.
 */
export async function readWorkItem(
  workItemId: string,
  ctx: TenantReadContext,
  tx?: Prisma.TransactionClient,
): Promise<WorkItem | null> {
  if (tx) return workItemRepository.findById(workItemId, tx);
  return withWorkspaceContext(ctx, (t) => workItemRepository.findById(workItemId, t));
}

// ─── The USERLESS tier (MOTIR-2685) ────────────────────────────────────────────
//
// The readers above bind `{ userId, workspaceId }`, which covers every read whose
// caller carries an acting user. A tail of reads does not, and it is not a tail of
// stragglers — it is a distinct KIND of caller. A GitHub webhook, a scheduled
// notification sweep, an automation rule firing on a change nobody is watching:
// each belongs to exactly one workspace and has no person attached. There is no
// `userId` to invent, and inventing one would be worse than the bug (it would
// attribute a job's reach to a user who never asked for it).
//
// So they bind the WORKSPACE tier instead — `withWorkspaceServiceContext`, which
// sets `app.workspace_id` and nothing else. That is sufficient here and no more
// than sufficient: `project_workspace_or_system_read` and `work_item_active_workspace`
// key purely on that GUC, and the restrictive `work_item_project_narrow` passes on
// its `coalesce(current_setting('app.project_id', true), '') = ''` branch when the
// GUC is unbound (the full argument is in that helper's docstring). It is NOT
// `withSystemContext`: `app.system_admin` is a cross-table, cross-TENANT flag, and
// a fan-out that reached the wrong workspace's watchers is a far worse outcome
// than one that reaches nobody.
//
// ⚠️ SECURITY — the workspace id must come from a TRUSTED resolution, never from
// user input (`withWorkspaceServiceContext`'s own constraint). Every caller added
// with this tier takes it off a job event envelope or a service argument the layer
// above already resolved, and each call site says so.
//
// ⚠️ The caller's explicit `workspaceId` comparison MUST STAY, exactly as it must
// for the actor-carrying readers above: under a BYPASSRLS role — what CI runs today
// and what production runs until MOTIR-2515 — RLS is inert and a foreign row comes
// back. Deleting the check because "RLS handles it" would split the behaviour by
// role, which is precisely what this chain exists to remove.

/**
 * A project by id for a caller that has a workspace but NO acting user, read inside
 * a transaction that binds `app.workspace_id`.
 *
 * Pass `tx` when the caller is ALREADY inside a context-bound transaction — the read
 * then shares that snapshot and its GUCs. **Do not pass a transaction that binds no
 * GUCs** (a bare `db.$transaction`): the read would see NULL context and return the
 * same false miss this function exists to remove.
 */
export async function readProjectForService(
  projectId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<Project | null> {
  if (tx) return projectRepository.findById(projectId, tx);
  return withWorkspaceServiceContext(workspaceId, (t) => projectRepository.findById(projectId, t));
}

/**
 * A work item by id for a caller that has a workspace but NO acting user. Nothing
 * binds `app.project_id`, so `work_item_project_narrow` imposes no restriction and
 * every project in the workspace stays visible — which is what these callers need:
 * they resolve the item BEFORE they know its project (the automation engine's
 * `resolveProjectId` literally exists to learn it from the row).
 *
 * Same `tx` contract as {@link readProjectForService}.
 */
export async function readWorkItemForService(
  workItemId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<WorkItem | null> {
  if (tx) return workItemRepository.findById(workItemId, tx);
  return withWorkspaceServiceContext(workspaceId, (t) =>
    workItemRepository.findById(workItemId, t),
  );
}
