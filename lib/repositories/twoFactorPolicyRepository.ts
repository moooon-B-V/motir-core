import type { Prisma } from '@/generated/prisma/client';

// Data access for the require-2FA policy verdict (Story MOTIR-1215 · Subtask
// MOTIR-3645). ONE method, ONE Prisma operation, per `CLAUDE.md`'s repository
// rule. The two column WRITES live on the entity repositories they belong to
// (`organizationRepository.update` / `workspaceRepository.update`) — an
// operation on the `organization` table belongs in the organization repository
// even though its only caller is this policy service.

/** One row, exactly as the query below shapes it. Every field may be null. */
export interface TwoFactorRequirementRow {
  orgId: string | null;
  orgName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  enabled: boolean;
  passkeyCount: number;
}

export const twoFactorPolicyRepository = {
  /**
   * Everything `resolveRequirement` needs, in ONE round trip.
   *
   * ⚠️ ONE QUERY IS A REQUIREMENT, NOT AN OPTIMISATION. This runs in the
   * `(authed)` layout on every signed-in page load (MOTIR-3648) and again on
   * every cookie-authenticated API call (MOTIR-3653). Four Prisma calls would
   * be four sequential round trips inside one transaction, on the hot path of
   * the whole product. `tests/twoFactorPolicy.test.ts` counts
   * the statements.
   *
   * ⚠️ IT MUST RUN INSIDE `withUserContext`, AND THE REASON IS A SILENT
   * FAILURE. Under the non-bypass `motir_app` role the GUCs are per
   * transaction, and the arms that admit these tables are the MEMBERSHIP-OWNED
   * ones, all keyed on `app.user_id`:
   *
   *   organization            organization_membership_visible
   *     id IN (SELECT "organizationId" FROM organization_membership
   *            WHERE "userId" = current_setting('app.user_id', true))
   *   workspace               workspace_membership_visible
   *     id IN (SELECT "workspaceId" FROM workspace_membership
   *            WHERE "userId" = current_setting('app.user_id', true))
   *   workspace_membership    membership_visible_active_or_own
   *     "workspaceId" = current_setting('app.workspace_id', true)
   *       OR "userId" = current_setting('app.user_id', true)
   *   organization_membership org_membership_visible_active_or_own
   *     "organizationId" = current_setting('app.organization_id', true)
   *       OR "userId" = current_setting('app.user_id', true)
   *
   * ⚠️ THE LOAD-BEARING GUC IS `app.user_id`, AND A CONTEXT THAT OMITS IT FAILS
   * SILENTLY IN THE PERMISSIVE DIRECTION. `user` carries no RLS at all, so the
   * account half still comes back; the two membership arms admit nothing; both
   * mandating ids are null; `required` computes `false`; and a person who
   * should have been held at the door walks through with nothing logged. A
   * refused write is loud — a denied read is a plausible subset.
   * `tests/twoFactorPolicy.test.ts` asserts exactly that against an unbound
   * transaction, so the binding is measured rather than described.
   *
   * ⚠️ CORRECTION TO THE CARD (MOTIR-3645, measured). MOTIR-3645 predicted the
   * hazard as a WORKSPACE-bound read hiding the user's other workspaces. It
   * does not: RLS policies are OR'd, and `withWorkspaceContext` binds
   * `app.user_id` as well, so `workspace_membership_visible` still admits every
   * workspace the person belongs to — asserted in the same file. The hazard is
   * real but its shape is *no user GUC*, not *the wrong workspace GUC*.
   * `withUserContext` is still the right binding here for a reason that
   * survives the correction: it is the MINIMAL one that works, and the
   * `(authed)` layout that calls this has not resolved an active workspace yet,
   * so there is no workspace id to bind.
   *
   * `user`, `passkey` and `two_factor` carry no RLS at all (`relrowsecurity`
   * false), so the account half needs no arm.
   *
   * ORDER: `name` then `id`, so a person in several mandating workspaces is
   * always told about the same one. Any total order would do; an arbitrary one
   * would make the surface flicker between page loads.
   */
  async findRequirement(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<TwoFactorRequirementRow | null> {
    const rows = await tx.$queryRaw<
      {
        org_id: string | null;
        org_name: string | null;
        workspace_id: string | null;
        workspace_name: string | null;
        enabled: boolean;
        passkey_count: number;
      }[]
    >`
      WITH mandating_org AS (
        SELECT o.id AS id, o.name AS name
        FROM organization_membership om
        JOIN organization o ON o.id = om."organizationId"
        WHERE om."userId" = ${userId} AND o.requires_two_factor
        ORDER BY o.name ASC, o.id ASC
        LIMIT 1
      ),
      mandating_workspace AS (
        SELECT w.id AS id, w.name AS name
        FROM workspace_membership wm
        JOIN workspace w ON w.id = wm."workspaceId"
        WHERE wm."userId" = ${userId} AND w.requires_two_factor
        ORDER BY w.name ASC, w.id ASC
        LIMIT 1
      )
      SELECT
        (SELECT id FROM mandating_org) AS org_id,
        (SELECT name FROM mandating_org) AS org_name,
        (SELECT id FROM mandating_workspace) AS workspace_id,
        (SELECT name FROM mandating_workspace) AS workspace_name,
        u."twoFactorEnabled" AS enabled,
        (SELECT COUNT(*)::int FROM passkey p WHERE p.user_id = u.id) AS passkey_count
      FROM "user" u
      WHERE u.id = ${userId}
    `;

    const row = rows[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      orgName: row.org_name,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      enabled: row.enabled,
      passkeyCount: row.passkey_count,
    };
  },
};
