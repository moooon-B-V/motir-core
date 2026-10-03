import type { PlatformOrgFeatureFlagDTO } from '@/lib/dto/platformFeatureFlags';
import { ORG_FEATURE_FLAG_REGISTRY, type OrgFeatureFlagKey } from '@/lib/featureFlags/registry';
import type { OrgFeatureFlagWithActor } from '@/lib/repositories/orgFeatureFlagRepository';

function actorLabel(user: { name: string | null; email: string }): string {
  return user.name ? `${user.name} <${user.email}>` : user.email;
}

/** One registry key + its override row (if any) → the console's switch row. */
export function toPlatformOrgFeatureFlagDTO(
  key: OrgFeatureFlagKey,
  row: OrgFeatureFlagWithActor | null,
): PlatformOrgFeatureFlagDTO {
  const def = ORG_FEATURE_FLAG_REGISTRY[key];
  return {
    key,
    enabled: row ? row.enabled : def.defaultEnabled,
    defaultEnabled: def.defaultEnabled,
    overridden: row !== null,
    whenOff: def.whenOff,
    reason: row?.reason ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy
      ? { userId: row.updatedBy.id, label: actorLabel(row.updatedBy) }
      : null,
  };
}
