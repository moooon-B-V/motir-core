import type { Component, User } from '@prisma/client';
import type { ComponentWithCount } from '@/lib/repositories/componentRepository';
import type { ComponentDto, ComponentUserDto, ComponentWithCountDto } from '@/lib/dto/components';

/**
 * Prisma `Component` → wire DTO (Story 5.4 · Subtask 5.4.3). Drops the
 * tenancy scalars (`workspaceId`/`projectId` — implicit in the routes that
 * serve it) and `nameLower` (a server-side uniqueness key, not display data
 * — the labelMappers rule).
 */
export function toComponentDto(row: Component): ComponentDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultAssigneeId: row.defaultAssigneeId,
  };
}

/**
 * Admin-list row: the component + its in-use count (from the repo's
 * `_count` include) + the default assignee resolved to a renderable user.
 * `usersById` comes from the service's ONE batched `findByIds` read over the
 * list's assignee ids (no N+1); a default whose user row is gone maps to
 * null (the SetNull departure semantics).
 */
export function toComponentWithCountDto(
  row: ComponentWithCount,
  usersById: ReadonlyMap<string, User>,
): ComponentWithCountDto {
  const assignee = row.defaultAssigneeId ? (usersById.get(row.defaultAssigneeId) ?? null) : null;
  return {
    ...toComponentDto(row),
    defaultAssignee: assignee ? toComponentUserDto(assignee) : null,
    itemCount: row._count.workItems,
  };
}

function toComponentUserDto(user: User): ComponentUserDto {
  return { id: user.id, name: user.name, email: user.email };
}
