import type { PlatformAuditTargetKind, PlatformRole } from '@/generated/prisma/client';

/**
 * What crosses the API boundary from the platform tier
 * (`docs/decisions/platform-staff-auth.md`).
 *
 * MOTIR-2896 defines only the audit row's shape. The estate / usage DTOs are
 * MOTIR-731–733's, and `PlatformUsageDTO` in particular is MOTIR-732's — the
 * ADR's "deliberately does NOT decide" table says so.
 */

/** One recorded platform-staff action. */
export interface PlatformAuditLogDTO {
  id: string;
  actorUserId: string;
  /** The actor's role AT THE TIME — snapshotted, never re-derived from a join. */
  actorRole: PlatformRole;
  action: string;
  targetKind: PlatformAuditTargetKind;
  targetId: string | null;
  targetLabel: string | null;
  organizationId: string | null;
  reason: string | null;
  /** ISO-8601, so the JSON shape is stable across the boundary. */
  createdAt: string;
}

/**
 * The acting operator, as a page renders it. NOT the full `PlatformPrincipal`:
 * that is a server-side identity assertion and must not be handed to a client
 * component. This carries what the console footer draws and nothing more.
 */
export interface PlatformOperatorDTO {
  email: string;
  role: PlatformRole;
}

/**
 * One account in the operator LOOKUP's result list (MOTIR-1167, design Panel 9's
 * door — the USER group Panel 3's global search promises).
 *
 * Deliberately thin. A lookup result is a row somebody is about to click, and
 * every field on it is a field an operator can read without opening the account
 * — which is a cross-tenant read of a person's data, and therefore something to
 * hand out by the spoonful rather than the bucket.
 */
export interface PlatformUserSummaryDTO {
  id: string;
  email: string;
  name: string;
  /** ISO-8601 — when the account was created. */
  createdAt: string;
  /** ISO-8601 when the account is suspended, else null. */
  suspendedAt: string | null;
}

/**
 * One account as the operator DRILL-DOWN renders it (design Panel 9).
 *
 * ⚠️ It carries NO tenant rows, and that absence is a decision rather than an
 * omission. The workspaces and organizations an account belongs to are tenant
 * tables, and no tenant table has gained a `platform_staff` READ arm — the ADR
 * (`docs/decisions/platform-staff-auth.md`, "What this ADR deliberately does NOT
 * decide") allocates every one of those policies to MOTIR-730. A read issued
 * against them from this tier answers with zero rows and raises nothing the day
 * MOTIR-2435 cuts over to the non-bypass role, which is the silent-narrowing
 * shape MOTIR-2880 recorded. So the day-1 drill-down reads only `user` and
 * `session`, both of which are in `tenant-root-creation-rls.test.ts`'s
 * DELIBERATELY_UNGUARDED map and therefore answer identically before and after
 * that cutover. The tenancy half arrives with the read layer that can serve it.
 */
export interface PlatformUserDetailDTO extends PlatformUserSummaryDTO {
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  /** The operator's stated reason for the LIVE suspension, else null. */
  suspendedReason: string | null;
  /** How many sign-in sessions the account currently holds. */
  activeSessionCount: number;
  /**
   * Platform standing, when the account has any. Almost always null — it is here
   * because an operator acting on a COLLEAGUE's account should see that they
   * are, before they suspend them.
   */
  platformRole: PlatformRole | null;
}

/**
 * The operator drill-down's whole page (MOTIR-1167, design Panel 9).
 *
 * One shape rather than two calls, because the page's two halves are ONE audited
 * read: the account, and every operator write on it. See
 * `platformSupportService.getUserPage` for why that matters to the trail.
 */
export interface PlatformUserPageDTO {
  user: PlatformUserDetailDTO;
  /**
   * Every operator WRITE on this account, newest first. Reads are filtered out
   * by the service — this is the log the design calls *"every operator write on
   * this account"*, and a page view is not one.
   */
  actions: PlatformAuditLogDTO[];
}
