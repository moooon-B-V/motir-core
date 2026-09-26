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
