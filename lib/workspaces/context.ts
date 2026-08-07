import type { Prisma } from '@/lib/generated/prisma/client';
import { db } from '@/lib/db';

// Runtime half of the workspace-RLS pair (the DB half lives in
// prisma/migrations/.../add_workspace_rls and .../add_work_item_rls). Every
// tenant-scoped query path opens a transaction via withWorkspaceContext,
// which sets three per-transaction GUCs the RLS policies read:
//   app.user_id      — the authenticated user's id
//   app.workspace_id — the active workspace id
//   app.project_id   — the active project id, OR empty string when no
//                      project is active. Read by the work_item table's
//                      restrictive project-narrowing policy (1.4.5): when
//                      empty, all of the workspace's projects are visible;
//                      when set, work_item reads narrow to that one project.
//                      Always bound (empty string when absent) so the
//                      policy's `coalesce(...) = ''` branch fires cleanly
//                      with no "unset vs empty" ambiguity. Unused by the
//                      workspace/project/work_item_link policies.
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
  /**
   * Optional active-project id. When provided, work_item reads narrow to
   * this project (the restrictive project policy from add_work_item_rls);
   * when omitted, all of the workspace's projects are visible. Bound as the
   * `app.project_id` GUC (empty string when absent). Does not affect writes
   * or the work_item_link table — those are workspace-scoped only.
   */
  projectId?: string;
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
    // Always bind app.project_id (empty string when no project is active) so
    // the work_item project-narrowing policy's `coalesce(...) = ''` branch
    // fires cleanly — no ambiguity between "unset" and "deliberately empty".
    await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId ?? ''}, true)`;
    return fn(tx);
  });
}

/**
 * Opens a Prisma transaction binding the `app.system_admin` GUC to `'true'`,
 * then invokes `fn` with the transaction client. This is the TRUSTED-WRITER /
 * cross-workspace-admin context for the job-ledger tables (job_run /
 * job_run_dlq, Subtask 1.6.4): their RLS policy admits any row — tenanted or
 * untenanted — when system_admin is set.
 *
 * Two callers, by design:
 *   * the background-jobs runtime (jobRunsService, run by defineJob) — it
 *     writes ledger rows OUTSIDE any HTTP request, so it has no active
 *     workspace context; the system-admin branch is what lets its INSERT/UPDATE
 *     pass WITH CHECK under the non-bypass prodect_app role.
 *   * operator tooling that must see SYSTEM rows (workspace_id IS NULL) or span
 *     workspaces (the 1.6.5 dashboard's system tab).
 *
 * SECURITY: this helper is NEVER fed user input — it binds a constant. A tenant
 * request path uses withWorkspaceContext (which binds only user/workspace/
 * project), so a tenant can never elevate itself to system_admin. Keep it that
 * way: do not thread a request-derived flag into this function.
 */
export async function withSystemContext<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    return fn(tx);
  });
}

/**
 * Opens a Prisma transaction binding ONLY the `app.workspace_id` GUC (no
 * `app.user_id`, no `app.system_admin`), then invokes `fn` with the transaction
 * client. This is the workspace-tier analogue of
 * `withOrgServiceWriteContext` (lib/organizations/context.ts): the context for a
 * TRUSTED path that operates within ONE workspace WITHOUT an acting user.
 *
 * The caller today is the CI-minutes meter (Story MOTIR-1775 · MOTIR-1896),
 * which resolves a GitHub `workflow_run` delivery to its tenant. A webhook has
 * no session, so there is no user to bind — but `withSystemContext` would be the
 * WRONG tool: `system_admin` is a cross-table, cross-tenant flag, and the meter
 * needs to read exactly one workspace's rows. Binding the workspace id keeps the
 * reach row-scoped, so RLS itself enforces that a repo can only be attributed
 * inside the tenant that holds its installation.
 *
 * Sufficient for tables whose policy gates PURELY on `workspace_id` — the
 * `project_repository` / `sprint` / `plan` shape, and the `workspace_active`
 * SELECT policy. NOT sufficient for a policy that also reads `app.user_id`
 * (membership-gated rows) or `app.project_id` (the `work_item` project
 * narrowing), which is deliberate: a path that needs those has an acting user
 * and should use `withWorkspaceContext`.
 *
 * SECURITY: the workspace id must come from a TRUSTED resolution (the meter
 * takes it from the stored `github_installation` row the delivery's installation
 * id resolves to), never from user input — exactly the constraint
 * `withOrgServiceWriteContext` documents. The policy confines the effect to that
 * one workspace, so it grants no broader reach than the id already implies.
 *
 * `options` raises Prisma's interactive-transaction budget for the ONE path that
 * needs it — see {@link TransactionBudget}. Omit it and the default 5s applies,
 * which is what every shipped caller wants.
 */
export async function withWorkspaceServiceContext<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TransactionBudget,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    },
    options ? { timeout: options.timeoutMs, maxWait: options.maxWaitMs } : undefined,
  );
}

/**
 * An explicit, raised budget for an interactive transaction.
 *
 * Prisma's default is `timeout: 5000` / `maxWait: 2000`, and that default is
 * correct for essentially everything: a transaction is a lock held on live rows,
 * and a long one is usually a design smell. It is stated as a TYPE rather than
 * two loose numbers so that raising it is a visible, argued decision at the call
 * site instead of a magic literal.
 *
 * The one shipped caller is the per-project runner-group sync (MOTIR-1972),
 * which must hold the project's row lock ACROSS its GitHub calls because the
 * access list it writes is read-derived — see that service's header for why the
 * lock cannot be released first.
 */
export interface TransactionBudget {
  /** Max wall-clock ms the transaction body may run before Prisma rolls back. */
  timeoutMs: number;
  /** Max ms to wait for a free connection before the transaction even starts. */
  maxWaitMs: number;
}

/**
 * Opens a Prisma transaction binding ONLY the `app.user_id` GUC, then
 * invokes `fn` with the transaction client. This is the half-context used
 * while RESOLVING which workspace a request acts within: the workspace id
 * isn't known yet (that's what the resolver is computing), so only the
 * user GUC can be bound. The membership-scoped RLS policies still bite —
 * they gate on `app.user_id` — so a non-superuser connection sees only the
 * caller's own membership rows.
 *
 * Once the active workspace is known, tenant-scoped query paths should use
 * withWorkspaceContext (both GUCs) instead.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
}
