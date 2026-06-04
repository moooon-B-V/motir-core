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

/**
 * Input to `workItemsService.linkWorkItems` (Subtask 1.4.4). Reads as
 * "fromId <kind> toId" (the Jira direction convention). `createdById` is
 * taken from the ServiceContext (`ctx.userId`) and `workspaceId` is derived
 * inside the service from `fromItem.workspaceId` — neither crosses the wire,
 * so neither appears here. For `kind === 'relates_to'` the service also
 * persists the reciprocal toId→fromId row in the same transaction; the
 * caller still passes a single directed input.
 */
export interface LinkWorkItemsInput {
  fromId: string;
  toId: string;
  kind: WorkItemLinkKindDto;
}

/**
 * The FIVE UI-facing relationship kinds shown in the link-management surface
 * (2.4.8 design / 2.4.9). Distinct from the four STORAGE kinds
 * ({@link WorkItemLinkKindDto}): `blocked_by` and `blocks` are the two
 * DIRECTIONS of the single `is_blocked_by` storage edge — the action layer maps
 * a (current item, target, relationship) triple to the directed
 * {@link LinkWorkItemsInput} (see `lib/workItems/linkRelationships.ts`).
 */
export type RelationshipKind = 'blocked_by' | 'blocks' | 'relates_to' | 'duplicates' | 'clones';
