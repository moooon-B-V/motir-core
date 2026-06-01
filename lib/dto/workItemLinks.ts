// DTOs for the work-item-link endpoints + surfaces (Subtask 1.4.3). These
// define EXACTLY what crosses the HTTP / Server-Action boundary — no Prisma
// model leaks. The service layer (1.4.4) returns these, never raw Prisma
// rows.
//
// Wire-safe scalar choices: the kind enum is a string-literal union (mirrors
// the Prisma enum labels, but defined here so the DTO module stays Prisma-
// free); `DateTime` becomes an ISO-8601 `string`. The mapper owns those
// conversions.
//
// `workspaceId` is intentionally NOT exposed past the API boundary — it's
// internal RLS infrastructure (the requester is already workspace-scoped
// via their session, so re-emitting it would be redundant noise and would
// invite client code to treat it as authoritative when it isn't).

export type WorkItemLinkKindDto = 'is_blocked_by' | 'relates_to' | 'duplicates' | 'clones';

/**
 * The wire shape of a work-item-to-work-item link. Carries direction
 * (fromId → toId), the kind discriminant, audit fields (createdById,
 * createdAt), and the link's id (for delete / undo). Read as
 * "fromId <kind> toId".
 */
export interface WorkItemLinkDto {
  id: string;
  fromId: string;
  toId: string;
  kind: WorkItemLinkKindDto;
  createdById: string;
  createdAt: string;
}
