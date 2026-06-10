// Prisma → DTO conversion for the activity feed (Subtask 5.5.1). The "row"
// here is a `WorkItemRevision` plus the page's pre-built DisplayResolvers —
// the mapper is pure assembly: anchor/diff parts via the renderer registry,
// actor via the same batched user map every other reference resolved through.

import type { WorkItemRevision } from '@prisma/client';
import type { ActivityEntryDto } from '@/lib/dto/activity';
import { buildEntryParts, type DisplayResolvers } from '@/lib/activity/renderers';

export function toActivityEntryDto(
  row: WorkItemRevision,
  resolvers: DisplayResolvers,
): ActivityEntryDto {
  const actor = resolvers.user(row.changedById);
  return {
    id: row.id,
    workItemId: row.workItemId,
    changeKind: row.changeKind,
    changedAt: row.changedAt.toISOString(),
    actor: { userId: actor.userId, name: actor.name, image: actor.image },
    parts: buildEntryParts(row.changeKind, row.diff, resolvers),
  };
}
