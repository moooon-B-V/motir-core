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
