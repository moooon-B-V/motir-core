import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// Runtime half of the workspace-RLS pair (the DB half lives in
// prisma/migrations/.../add_workspace_rls). Every tenant-scoped query
// path opens a transaction via withWorkspaceContext, which sets two
// per-transaction GUCs the RLS policies read:
//   app.user_id      — the authenticated user's id
//   app.workspace_id — the active workspace id
//
// Why $transaction (not just $executeRaw on the singleton): SET LOCAL /
// set_config(..., true) are transaction-scoped. Outside a transaction
// each statement is its own implicit txn, so the GUC would die between
// the SET and the next query — leaving the RLS policies seeing NULL and
// hiding everything. Wrapping the work in $transaction binds the GUC to
// every query routed through the `tx` client.
//
// Why set_config(..., true) instead of `SET LOCAL`: SET LOCAL is a
// statement, not an expression, so it can't accept parameter bindings.
// Passing user-supplied values through it would require string
// interpolation (SQL injection risk). set_config() is a function call
// that accepts parameters, so Prisma's tagged-template $executeRaw
// binds userId/workspaceId safely.

export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
}

/**
 * Opens a Prisma transaction, binds the workspace + user GUCs the RLS
 * policies read, and invokes `fn` with the transaction client. Every
 * query issued through `tx` inside `fn` sees the GUCs and is RLS-scoped
 * to the workspace; once the transaction ends the GUCs are discarded.
 */
export async function withWorkspaceContext<T>(
  ctx: WorkspaceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    return fn(tx);
  });
}
