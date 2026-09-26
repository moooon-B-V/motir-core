// Organization deletion — what crosses the API boundary (Story MOTIR-6306 ·
// MOTIR-6391). Contract: `docs/decisions/organization-deletion.md` (MOTIR-6389).
// Dates are ISO strings, like every DTO here.

/** Where a deletion stands. Mirrors the `organization_deletion_status` enum. */
export type OrganizationDeletionStatusDTO =
  | 'scheduled'
  | 'cancelled'
  | 'erasing'
  | 'erased'
  | 'purged';

/** One deletion request, as the settings page, the banner and the API read it. */
export interface OrganizationDeletionRequestDTO {
  id: string;
  organizationId: string;
  status: OrganizationDeletionStatusDTO;
  /** Who scheduled it — null once that account is gone. */
  requestedByUserId: string | null;
  /** When the Owner asked. The window is measured from here. */
  requestedAt: string;
  /** When the org is erased — `requestedAt + ORGANIZATION_DELETION_WINDOW_DAYS`,
   *  read from the stored row, never recomputed. */
  erasureDueAt: string;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  erasedAt: string | null;
}

/** One repository Motir hosts for the organization — deleted by the erasure
 *  unless it is taken over first (DECISION §6.1). */
export interface OrganizationHostedRepoDTO {
  id: string;
  fullName: string;
}

/**
 * What the Delete organization dialog's first step lists (Story MOTIR-6306 ·
 * MOTIR-6402, design MOTIR-6390 panel 2) — every number read on the server, so
 * the dialog never shows one the erasure would not act on.
 */
export interface OrganizationDeletionConsequencesDTO {
  workspaceNames: string[];
  projectCount: number;
  memberCount: number;
  hostedRepos: OrganizationHostedRepoDTO[];
  /** When the org would be erased if scheduled now — `now + 30 days`, the same
   *  arithmetic the schedule stores. */
  erasureDueAt: string;
  /** Whether the Owner's account has a password — decides the step-up field. */
  hasPassword: boolean;
  /** For an account with no password: whether the acting session was created
   *  inside the step-up window, so no Sign in again is needed (DECISION §1). */
  signedInRecently: boolean;
}
