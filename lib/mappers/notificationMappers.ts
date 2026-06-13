import type { Notification, User } from '@prisma/client';
import type {
  NotificationActorDTO,
  NotificationData,
  NotificationDTO,
} from '@/lib/dto/notifications';

// Prisma → DTO converters for the notifications domain (Story 5.7 · Subtask
// 5.7.4). The service batches the actor lookup — ONE user read per page (no
// N+1) — and hands the bucket in; the mapper is pure shaping.

/**
 * Resolve a notification's actor from the batched user read. Unlike the
 * comment author (`onDelete: Restrict`, always present), the notification
 * `actor` relation is `onDelete: SetNull` (5.7.2) and `actorId` is nullable, so
 * a null `actorId` (a system notification) OR a deleted actor (id present in
 * the row but absent from the batch because the user is gone) both resolve to
 * `null` — a renderable "no actor" state, never a thrown error.
 */
function actorFor(row: Notification, actorsById: Map<string, User>): NotificationActorDTO | null {
  if (!row.actorId) return null;
  const user = actorsById.get(row.actorId);
  if (!user) return null;
  return { id: user.id, name: user.name, image: user.image ?? null };
}

export function toNotificationDto(
  row: Notification,
  actorsById: Map<string, User>,
): NotificationDTO {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    actor: actorFor(row, actorsById),
    workItemId: row.workItemId,
    // The `data Json` column is the denormalized render payload captured at
    // fan-in (5.7.3). Its shape is the NotificationData contract; an absent /
    // malformed payload renders as the empty object rather than crashing the
    // feed read.
    data: (row.data ?? {}) as NotificationData,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
