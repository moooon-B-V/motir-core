import type { WatcherWithUser } from '@/lib/repositories/watcherRepository';
import type { WatcherDto } from '@/lib/dto/watchers';

/**
 * Prisma `Watcher` (+ its user) → wire DTO (Story 5.4 · Subtask 5.4.4). The
 * popover renders Avatar · name, so only the user's display fields cross the
 * boundary; the join-row id stays server-side (it is the list's page cursor,
 * surfaced as `nextCursor` at the page level, never per row).
 */
export function toWatcherDto(row: WatcherWithUser): WatcherDto {
  return { userId: row.userId, name: row.user.name, image: row.user.image };
}
