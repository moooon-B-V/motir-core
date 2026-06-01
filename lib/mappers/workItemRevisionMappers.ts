import type { WorkItemRevision } from '@prisma/client';
import type { WorkItemRevisionDto } from '@/lib/dto/workItems';

// Prisma → DTO conversion for work-item revisions (Subtask 1.4.6). Mirrors
// the wire-safe choices the other work-item mappers make: `DateTime` →
// ISO-8601 `string`. The DTO module stays Prisma-free, so the union narrowing
// happens here at the boundary.

/**
 * Map a stored revision row to its wire DTO. Two boundary casts:
 *   - `changeKind`: the DB column is plain `text` (so future kinds need no
 *     enum ALTER — see the schema note), the DTO constrains it to the current
 *     union. The service is the validation boundary — it only ever writes the
 *     three union values — which is what makes this cast safe.
 *   - `diff`: stored as opaque JSON; the DTO pins the `{ field: {from, to} }`
 *     wire shape the service produces.
 */
export function toWorkItemRevisionDto(row: WorkItemRevision): WorkItemRevisionDto {
  return {
    id: row.id,
    workItemId: row.workItemId,
    changedById: row.changedById,
    changedAt: row.changedAt.toISOString(),
    changeKind: row.changeKind as WorkItemRevisionDto['changeKind'],
    diff: row.diff as WorkItemRevisionDto['diff'],
  };
}
