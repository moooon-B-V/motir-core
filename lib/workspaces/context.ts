import type { Prisma } from '@/generated/prisma/client';
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
//
// ⚠️ THE SHAPE OF A BOUND READ PATH — ONE TRANSACTION PER SERVICE METHOD.
// Decided and MEASURED in docs/decisions/bound-read-transaction-shape.md
// (MOTIR-2799). Because the GUCs are transaction-local, every read of a
// policy-gated table needs a transaction, and a method with N reads could
// open one transaction (N sequential reads) or N transactions (still
// parallel). The convention is ONE, at the SERVICE-METHOD boundary, with
// `tx` threaded into every read beneath it:
//
//   * A repository read of a policy-gated table takes `tx?:
//     Prisma.TransactionClient` LAST and resolves `const client = tx ?? db`.
//     That is also the form tests/rls/singletonReadScan.ts treats as
//     BINDABLE, so adding it removes the read from the scan.
//   * A `Promise.all` inside the boundary collapses to sequential awaits.
//     That is the accepted cost: measured on a 10 000-item corpus, the
//     widest fan-out that can be built from reportsService's reads goes
//     58 ms -> 118 ms, while total pooled-connection TIME is unchanged —
//     one transaction per method holds ONE Neon pool slot per request
//     instead of N, and the pooler (measured: ~98 server connections, then
//     it QUEUES rather than erroring) turns N-at-once into a request whose
//     latency is the MAX of N queue waits.
//   * A read already inside a bound transaction threads THAT `tx`. Never
//     open a second — Prisma rejects nesting.
//   * Read paths do NOT pass `options`. 118 ms against a 5 s default is a
//     38x margin; see {@link TransactionBudget}, whose single shipped
//     caller is a very different justification.
//
// The ONE sanctioned exception is STRUCTURAL, never performance: a fan-out
// whose members need DIFFERENT bindings. `publicProjectsService` is it —
// `work_item_public_project_read` fires only when `app.workspace_id` is
// UNSET, so its page mixes bound and deliberately unbound reads and no
// single transaction can express both. Wanting (B) for speed requires a
// measurement in the PR showing this shape past a stated budget.

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
 *     pass WITH CHECK under the non-bypass motir_app role.
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
 * The first caller was the CI-minutes meter (Story MOTIR-1775 · MOTIR-1896),
 * which resolves a GitHub `workflow_run` delivery to its tenant. A webhook has
 * no session, so there is no user to bind — but `withSystemContext` would be the
 * WRONG tool: `system_admin` is a cross-table, cross-tenant flag, and the meter
 * needs to read exactly one workspace's rows. Binding the workspace id keeps the
 * reach row-scoped, so RLS itself enforces that a repo can only be attributed
 * inside the tenant that holds its installation. MOTIR-2685 added the rest of
 * the userless paths — the notification / automation job runtime and the
 * `workspaceId`-only service helpers — through `readProjectForService` /
 * `readWorkItemForService` (`lib/workspaces/tenantRead.ts`).
 *
 * SUFFICIENCY, table by table. Sufficient for every policy that gates PURELY on
 * `workspace_id` — the `project_repository` / `sprint` / `plan` shape, the
 * `workspace_active` SELECT policy, `workflow_status` / `workflow_transition`,
 * `project` (`project_workspace_or_system_read`, whose other arm is the
 * system-admin one), and `work_item`. NOT sufficient for a policy that also
 * reads `app.user_id` (membership-gated rows), which is deliberate: a path that
 * needs one has an acting user and should use `withWorkspaceContext`.
 *
 * `work_item` is the case worth spelling out, because this note used to claim
 * the opposite. Its permissive policy `work_item_active_workspace` keys purely
 * on `app.workspace_id`; the RESTRICTIVE `work_item_project_narrow` AND'd onto
 * it reads `app.project_id`, but it is satisfied — not defeated — when the GUC
 * is unbound, because its first branch is
 *
 *     coalesce(current_setting('app.project_id', true), '') = ''
 *     OR "projectId" = current_setting('app.project_id', true)
 *
 * (`prisma/migrations/20260601074342_add_work_item_rls/migration.sql`). An
 * unbound GUC coalesces to `''`, the branch is true, and the policy imposes no
 * restriction — every project in the workspace stays visible, which is exactly
 * what a userless caller resolving an item BEFORE it knows the project needs.
 * Narrowing is opt-IN, so not opting in is not a hole. (Reading "the policy
 * reads `app.project_id`" as "the context must bind it" is the mis-inference
 * this paragraph exists to stop: a shipped comment that contradicts the shipped
 * SQL is how the next reader re-derives the wrong answer.)
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
 * Opens a Prisma transaction binding ONLY `app.bootstrap_slug`, then invokes `fn`
 * with the transaction client. The narrowest context in this file: it admits
 * exactly ONE row — the workspace (or organization) whose `slug` equals the bound
 * value — through the `*_visible_bootstrap` policies from
 * `20260810001000_tenant_root_insert_policies`.
 *
 * Two callers, and they are the same shape from opposite ends:
 *   * `workspacesService.createWorkspace`, which must READ BACK the tenant root it
 *     is creating before any `app.workspace_id` exists to bind (it binds the slug
 *     inline, as part of a larger transaction).
 *   * `scripts/stampOnboardingRan.ts` (MOTIR-2813), which resolves a workspace by
 *     slug as an OPERATOR — no active workspace, and the slug IS the handle.
 *
 * SECURITY: the slug is a HANDLE, not an authorisation. Binding it grants sight of
 * that one row and nothing else — no items, no projects, no memberships — which is
 * why it is safe for a resolve that has no tenant yet and why it must never be
 * used as a substitute for `withWorkspaceContext` once one is known.
 */
export async function withBootstrapSlugContext<T>(
  slug: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', ${slug}, true)`;
    return fn(tx);
  });
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
