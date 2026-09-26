import { type Organization, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { bindOrganizationContext } from '@/lib/organizations/context';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Organization repository — single Prisma operations on the `organization`
// table (the root tenancy tier, Story 6.10). The org-scoped business logic
// (CRUD orchestration, the access gate, the signup auto-provision, the
// cross-workspace member roster) lives in `organizationsService` (6.10.4); this
// file is data access only — each method is one Prisma call, writes require
// `tx`. Mirrors `workspaceRepository`.

/** The signals `pmTierForOrg` (8.1.11) resolves an org's §4 tier from: the
 *  `isMeta` exemption flag, the scaled-tracker (purchased-seat) subscription, and
 *  the `aiIncludedSeat` flag (a PAID AI plan bundles a seat → lifts caps, 8.1.24). */
export interface OrgCapContext {
  isMeta: boolean;
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
  aiIncludedSeat: boolean;
}

/** Normalise a selected org row (or a missing/hidden one) into an `OrgCapContext`.
 *  Absent → the safe default (`isMeta: false`, no subscription, no AI seat → bounded `free`). */
function toCapContext(
  org: {
    isMeta: boolean;
    scaledTrackerSubscription: Prisma.JsonValue;
    aiIncludedSeat: boolean;
  } | null,
): OrgCapContext {
  return {
    isMeta: org?.isMeta ?? false,
    scaledTrackerSubscription:
      (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null,
    aiIncludedSeat: org?.aiIncludedSeat ?? false,
  };
}

export const organizationRepository = {
  /**
   * Find by id inside the caller's transaction so the organization RLS policy
   * (which keys off the per-transaction `app.organization_id` / `app.user_id`
   * GUCs bound by the 6.10.4 org-context layer) admits the row under the
   * non-bypass `motir_app` role. Used by role-gated reads that guard a
   * subsequent write.
   *
   * There is no `db`-singleton variant any more (MOTIR-2775). One existed, returned
   * NULL under RLS by design, had ZERO production callers, and survived only on the
   * tests that asserted it — a method that cannot work is a trap in proportion to how
   * inviting its name is, and `findById` is about as inviting as a name gets.
   */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id } });
  },

  /**
   * When organization `id` started CLOSING, or null when it is not closing
   * (MOTIR-6396) — the org-tier write guard's read (`lib/organizations/closingGuard.ts`).
   * Takes `tx`: it guards a write, and the caller's context admits the row.
   */
  async findClosingSinceById(id: string, tx: Prisma.TransactionClient): Promise<Date | null> {
    const row = await tx.organization.findUnique({ where: { id }, select: { closingSince: true } });
    return row?.closingSince ?? null;
  },

  /**
   * The CLOSING organization that owns `workspaceId`, or null when that org is
   * open (MOTIR-6396) — the workspace-addressed twin of {@link findClosingSinceById},
   * returning the org id the refusal names.
   */
  async findClosingByWorkspaceId(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ organizationId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ organizationId: string }>>`
      SELECT o."id" AS "organizationId"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE w."id" = ${workspaceId}
        AND o."closing_since" IS NOT NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  },

  /**
   * When the organization that owns `workspaceId` started CLOSING, or null when it
   * is not closing (Story MOTIR-6306 · MOTIR-6396) — the one read the permission
   * resolution adds, so that every actor in every workspace of a closing org
   * resolves to read-only.
   *
   * Through the workspace, in ONE statement, because the resolver is handed a
   * workspace and never an org. Takes `tx`: both rows are RLS-gated, and the
   * caller's transaction is the one binding the GUCs that admit them — a workspace
   * member is always an org member (`organization-tier.md`, the upward invariant),
   * so `organization_membership_visible` admits the org; an unbound public read is
   * admitted by `organization_public_project_read`. A row that is not visible
   * reads as not closing — the answer for a workspace the caller cannot see is
   * decided by the gates around this read, not by it. `tx` is optional ONLY for
   * that unbound public path (`dbRead`, the MOTIR-4295 rule).
   */
  async findClosingSinceByWorkspaceId(
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ closingSince: Date | null }>>`
      SELECT o."closing_since" AS "closingSince"
      FROM "workspace" w
      JOIN "organization" o ON o."id" = w."organizationId"
      WHERE w."id" = ${workspaceId}
      LIMIT 1
    `;
    return rows[0]?.closingSince ?? null;
  },

  /**
   * Of the organisation ids given, which still have a row — the liveness read
   * motir-ai's code-graph reconciler subtracts from its own bucket enumeration
   * (MOTIR-4647). Answers about the ids it is GIVEN and never enumerates, so a
   * leak can never be larger than what the caller already knew.
   *
   * ⚠️ NO HOP TO A CHILD ROW, and that is the substantive difference from
   * `projectRepository.findLivePairs`. That read asserts the project's workspace
   * still exists, because a project without one is not a live tenancy. An
   * organisation is the ROOT tier: it is live because its own row is there, and
   * an org with zero workspaces and zero projects is a live org that has not
   * been used yet. Joining anything here would report a real customer `absent`
   * and delete their graphs.
   *
   * ⚠️ `tx` IS REQUIRED, AND REQUIRED IS THE SAFETY PROPERTY — not a layering
   * formality. `organization` is RLS-protected and the only arm that admits a
   * cross-tenant read is `organization_system_read`
   * (`20260817120000_system_admin_read_arms_workspace_organization`), which reads
   * the `app.system_admin` GUC bound by `withSystemContext` for the life of ONE
   * transaction. Called on the `db` singleton this method would return ZERO ROWS
   * AND RAISE NOTHING — every organisation reported `absent`, which is the
   * delete-everything answer. That migration exists because the project-shaped
   * read had exactly this bug; taking a required `tx` makes it unreachable here
   * rather than merely documented.
   */
  async findLiveIds(ids: string[], tx: Prisma.TransactionClient): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async create(
    data: { name: string; slug: string },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.create({ data });
  },

  async update(
    id: string,
    data: {
      name?: string;
      slug?: string;
      isMeta?: boolean;
      /** The org-tier require-2FA policy (Story MOTIR-1215 · MOTIR-3644). */
      requiresTwoFactor?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data });
  },

  /**
   * Row-lock the organization `FOR UPDATE` inside the caller's transaction — the
   * serialization anchor for the §4 count-guarded creates (8.1.11). The work-item
   * / project / workspace caps read a count then create; without a shared lock
   * two concurrent creates both observe `count = limit - 1`, both pass, and both
   * insert (a warm-pool TOCTOU overage — CLAUDE.md § lock-before-read-derived).
   * Locking the single org row serializes every create under the org: the second
   * racer blocks until the first commits, then re-counts and correctly sees the
   * limit. Returns whether a row was actually LOCKED — `false` means the caller
   * is NOT serialized and must refuse rather than proceed (see
   * `entitlementsService`'s `lockOrgRowOrRefuse`).
   * `tx` REQUIRED — a row lock lives only for its transaction.
   *
   * ⚠️ THE BINDING ON THE FIRST LINE IS LOAD-BEARING — WITHOUT IT THIS LOCKED
   * NOTHING, SILENTLY (MOTIR-3710). Postgres applies the UPDATE policy's `USING`
   * clause to a `SELECT … FOR UPDATE`, because locking a row for update implies
   * update permission — and a row that fails it is FILTERED OUT rather than
   * refused. `organization`'s only UPDATE policy is `organization_mutate_active`
   * (`id = current_setting('app.organization_id', true)`), so from a context that
   * does not bind that GUC — `withWorkspaceContext`, which binds user / workspace
   * / project and nothing else, and which is what every §4 count-cap runs inside —
   * this statement matched ZERO rows, locked nothing, and let every racer through
   * together. Measured before the fix: `{ locked: false, visibleOrgRows: 1 }`. The
   * row was READABLE the whole time (`organization_membership_visible` admits it),
   * which is exactly why the guard read as working.
   *
   * The bind lives HERE rather than at the three call sites because a method whose
   * entire job is "lock THIS org row" cannot do it without the GUC that admits the
   * row, and a lock that silently no-ops is a trap in proportion to how inviting
   * its name is — the same argument `findByIdInTx` above makes (MOTIR-2775). It is
   * ADDITIVE and transaction-local, and it admits exactly the one org row named
   * here and nothing else (`withOrgServiceWriteContext`'s note in
   * `lib/organizations/context.ts` is the reasoning).
   *
   * SECURITY: `id` must be a TRUSTED, server-resolved organization id — every
   * caller resolves it UP from the workspace row, or has already bound the same id
   * itself — never raw request input. Same constraint `bindOrganizationContext`
   * documents.
   */
  async lockByIdForUpdate(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    await bindOrganizationContext(tx, id);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "organization" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows.length > 0;
  },

  /**
   * Read the org's §4 cap context (8.1.11) inside the caller's transaction — the
   * `isMeta` exemption flag + the scaled-tracker subscription, the two signals
   * `pmTierForOrg` resolves the tier from. A missing/hidden org collapses to
   * `{ isMeta: false, scaledTrackerSubscription: null }` (safe-by-default: the
   * bounded `free` tier, caps apply).
   */
  async findCapContextInTx(id: string, tx: Prisma.TransactionClient): Promise<OrgCapContext> {
    const org = await tx.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true, aiIncludedSeat: true },
    });
    return toCapContext(org);
  },

  /**
   * Read-only (db-singleton) variant of {@link findCapContextInTx} for the §4
   * upload path (8.1.11), which checks the per-file + total-storage caps as a
   * standalone read BEFORE the blob round-trip — no create transaction to thread.
   * Missing/hidden org → the safe default (bounded `free` tier, caps apply).
   */
  async findCapContext(id: string, tx?: Prisma.TransactionClient): Promise<OrgCapContext> {
    const client = tx ?? dbRead;
    const org = await client.organization.findUnique({
      where: { id },
      select: { isMeta: true, scaledTrackerSubscription: true, aiIncludedSeat: true },
    });
    return toCapContext(org);
  },

  /**
   * Set (or clear) the org's scaled-tracker subscription state (8.1.4c). A
   * non-null `state` writes the propagated subscription JSON; `null` clears the
   * column to SQL NULL via `Prisma.DbNull` (the cancel path — non-destructive,
   * `billing-tiering.md` §4). Throws Prisma `P2025` when the org row is absent
   * or RLS-hidden; the service maps that to `OrganizationNotFoundError`. Must
   * run inside a tx whose `app.organization_id` GUC matches `id` (see
   * `withOrgServiceWriteContext`) so the `organization_mutate_active` RLS policy
   * admits the UPDATE under the non-bypass `motir_app` role.
   */
  async updateScaledTrackerState(
    id: string,
    state: ScaledTrackerSubscription | null,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({
      where: { id },
      data: {
        scaledTrackerSubscription:
          state === null ? Prisma.DbNull : (state as unknown as Prisma.InputJsonValue),
      },
    });
  },

  /**
   * Set the org's `aiIncludedSeat` flag (8.1.24) — true while a PAID Motir AI
   * plan is active (it bundles 1 Motir seat → lifts the §4 caps), false clears
   * it. Same RLS/tx contract as {@link updateScaledTrackerState}; `P2025` when
   * the org is absent/hidden → the service maps it to `OrganizationNotFoundError`.
   */
  async updateAiIncludedSeat(
    id: string,
    included: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<Organization> {
    return tx.organization.update({ where: { id }, data: { aiIncludedSeat: included } });
  },
};
