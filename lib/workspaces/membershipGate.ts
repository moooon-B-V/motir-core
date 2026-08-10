import type { Prisma, WorkspaceMembership } from '@/generated/prisma/client';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';

// The membership READ every access gate makes — always context-bound.
//
// MOTIR-2527 (filed from the MOTIR-2514 inventory, `docs/rls-runtime-role-inventory.md`
// Finding 1). Under the non-bypass `motir_app` role the `membership_visible_active_or_own`
// policy admits a `workspace_membership` row only when
//   "workspaceId" = current_setting('app.workspace_id')  OR  "userId" = current_setting('app.user_id')
// and both GUCs are per-TRANSACTION. A gate that read through the `db` singleton bound
// neither, so both sides compared against NULL, the row was invisible, and the lookup
// returned `null` — which every gate reports as "not a member". It fails CLOSED and it
// fails DISHONESTLY: nothing logs an RLS denial, because there was no denial. The query
// succeeded and returned nothing. Measured cost: 1048 failures under `TEST_DB_APP_ROLE=1`,
// all of them this.
//
// So the gates do not choose a client any more — they call one of the two readers below,
// and the binding is a property of the reader, not of the call site.

/**
 * `(userId, workspaceId)`'s membership row, read inside a transaction that binds the
 * GUCs the `membership_visible_active_or_own` policy reads.
 *
 * Pass `tx` when the caller is ALREADY inside a context-bound transaction (a
 * `withWorkspaceContext` / `withUserContext` body) — the read then shares that snapshot
 * and its GUCs, which is what the 4-layer rule wants for a read that guards a write.
 * **Do not pass a transaction that binds no GUCs** (a bare `db.$transaction`): the read
 * would see NULL context and return the same false denial this function exists to remove.
 * Omit `tx` there and let this open its own bound one.
 *
 * Binding: `withWorkspaceContext({ userId, workspaceId })` — BOTH arms of the policy are
 * satisfied, so the row is admitted whether or not the subject is the acting user. That
 * is safe even when the subject is someone else (an assignee, an invitee, a triage
 * submitter): the transaction issues exactly ONE query, a `findUnique` on the
 * `(userId, workspaceId)` pair, so neither arm can widen the result past that one row.
 */
export async function readMembership(
  userId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<WorkspaceMembership | null> {
  if (tx) return workspaceMembershipRepository.findByUserAndWorkspaceInTx(userId, workspaceId, tx);
  return withWorkspaceContext({ userId, workspaceId }, (t) =>
    workspaceMembershipRepository.findByUserAndWorkspaceInTx(userId, workspaceId, t),
  );
}

/**
 * The same lookup for a gate that legitimately runs with **no active workspace** — the
 * actor's own membership is being read to decide whether a workspace is theirs at all,
 * so binding `app.workspace_id` would presume the answer.
 *
 * Binding: `withUserContext(userId)` — only the "or your own" arm of the policy, which
 * is exactly sufficient because the row sought is always the subject's own. Strictly
 * tighter than {@link readMembership}: nothing but this user's own memberships is
 * visible inside the transaction, so a cross-org actor resolving a PUBLIC project never
 * has that project's workspace bound on their behalf.
 */
export async function readOwnMembership(
  userId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<WorkspaceMembership | null> {
  if (tx) return workspaceMembershipRepository.findByUserAndWorkspaceInTx(userId, workspaceId, tx);
  return withUserContext(userId, (t) =>
    workspaceMembershipRepository.findByUserAndWorkspaceInTx(userId, workspaceId, t),
  );
}
