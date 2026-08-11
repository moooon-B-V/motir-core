import type { Prisma, Project, WorkItem } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

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
