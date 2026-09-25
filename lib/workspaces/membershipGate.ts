import type { MemberRole, Prisma, WorkspaceMembership } from '@/generated/prisma/client';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
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

/**
 * The actor's WORKSPACE ROLE FOR A GATE, with the org Owner composed in
 * (MOTIR-6308; `role-model.md` §1 — the Owner "acts with full rights in every
 * workspace and project", member or not): the stored membership role, or
 * `owner` for the Owner of the workspace's organization, or null for anyone
 * else with no membership. An org Admin gets no raise here — their reach is
 * their membership (reading R1).
 *
 * For the gates that answer "may this ACTOR act in this workspace". NOT for the
 * ones that ask whether some other SUBJECT is a member (an assignee, a
 * reporter, an invitee) — being the Owner does not put a person on a roster.
 *
 * Binding as {@link readMembership}: the owner join needs `app.workspace_id`
 * (`organizationMembershipRepository.isOwnerOfWorkspaceOrg`), so a `tx` passed
 * here must be a `withWorkspaceContext` body; omitted, this opens one.
 */
export async function readReachRole(
  userId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<MemberRole | null> {
  const run = async (t: Prisma.TransactionClient): Promise<MemberRole | null> => {
    const membership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
      userId,
      workspaceId,
      t,
    );
    return composeOwnerReach(userId, workspaceId, membership?.role ?? null, t);
  };
  if (tx) return run(tx);
  return withWorkspaceContext({ userId, workspaceId }, run);
}

/**
 * Compose the org Owner's reach onto an ALREADY-READ stored workspace role —
 * the half of {@link readReachRole} for a caller that read the membership row
 * itself (the project permission gate reads it through {@link readMembership}
 * or {@link readOwnMembership} and needs the row's other fields too).
 *
 * A stored manager role (`owner` / `admin`) already passes every workspace
 * gate, so it is returned without a read; anyone else costs one indexed round
 * trip. `tx` must bind `app.workspace_id` to `workspaceId`.
 */
export async function composeOwnerReach(
  userId: string,
  workspaceId: string,
  storedRole: MemberRole | null,
  tx: Prisma.TransactionClient,
): Promise<MemberRole | null> {
  if (storedRole === 'owner' || storedRole === 'admin') return storedRole;
  const isOwner = await organizationMembershipRepository.isOwnerOfWorkspaceOrg(
    userId,
    workspaceId,
    tx,
  );
  return isOwner ? 'owner' : storedRole;
}
