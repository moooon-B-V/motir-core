import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// Runtime half of the organization-RLS pair (Story 6.10). The DB half lives in
// prisma/migrations/.../add_organization_tier: the `organization` and
// `organization_membership` tables ENABLE + FORCE row-level security, and their
// policies read two per-transaction GUCs —
//   app.user_id          — the authenticated user's id (so a user's own
//                          membership rows + the orgs they belong to are
//                          visible BEFORE any org context is bound; this is what
//                          the org switcher / bootstrap path read)
//   app.organization_id  — the ACTIVE org id (the org row itself + its
//                          membership rows are visible/mutable only when this
//                          matches; UPDATE/DELETE on org + membership gate on it)
//
// Until this layer existed the org repos (organizationRepository,
// organizationMembershipRepository — 6.10.3) carried `*InTx` reads that assumed
// these GUCs would be bound by "6.10.4's org-context layer". This file IS that
// layer.
//
// Why $transaction (not $executeRaw on the singleton): set_config(..., true) is
// transaction-scoped — outside a transaction each statement is its own implicit
// txn, so the GUC would die between the SET and the next query, leaving the RLS
// policies seeing NULL and hiding everything. Wrapping the work in $transaction
// binds the GUCs to every query routed through `tx`. Why set_config(..., true)
// over `SET LOCAL`: SET LOCAL can't take a parameter binding, so passing a
// user-supplied id through it would require string interpolation (injection
// risk); set_config() is a function call that binds safely through Prisma's
// tagged-template $executeRaw. (Mirrors lib/workspaces/context.ts exactly.)

export interface OrganizationContext {
  userId: string;
  organizationId: string;
}

/**
 * Opens a Prisma transaction, binds the user + active-org GUCs the
 * organization RLS policies read, and invokes `fn` with the transaction
 * client. Every query issued through `tx` inside `fn` sees the GUCs and is
 * RLS-scoped to the org; once the transaction ends the GUCs are discarded.
 *
 * Used by the org-scoped write/read flows in organizationsService that operate
 * WITHIN a known active org (rename, member add/remove/role-change, the
 * cross-workspace roster) — the org-tier analogue of withWorkspaceContext.
 */
export async function withOrgContext<T>(
  ctx: OrganizationContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    return fn(tx);
  });
}
