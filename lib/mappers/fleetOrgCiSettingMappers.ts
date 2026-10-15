import type { User } from '@/generated/prisma/client';
import type { FleetOrgCiStoredStateDTO } from '@/lib/dto/fleetOrgCiSetting';
import type { PlatformFleetOrgCiRow } from '@/lib/repositories/platformFleetOrgCiRepository';

/** A stored setting row (or none, which is OFF) → the console's stored state. */
export function toFleetOrgCiStoredStateDTO(
  row: PlatformFleetOrgCiRow | null,
  updater: Pick<User, 'id' | 'email'> | null,
): FleetOrgCiStoredStateDTO {
  if (!row) return { enabled: false, updatedBy: null, updatedAt: null, lastReason: null };
  return {
    enabled: row.enabled,
    updatedBy: updater ? { userId: updater.id, email: updater.email } : null,
    updatedAt: row.updatedAt.toISOString(),
    lastReason: row.lastReason,
  };
}
