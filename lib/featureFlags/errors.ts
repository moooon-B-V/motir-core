import type { OrgFeatureFlagKey } from '@/lib/featureFlags/registry';

/**
 * A feature is DISABLED FOR THIS ORGANIZATION (Story 10.3 · MOTIR-750) — a
 * platform kill-switch is off, or the organization is suspended (MOTIR-748),
 * which turns every switch off without touching the stored overrides.
 *
 * → **403 `ORG_FEATURE_DISABLED`**, carrying `key` so a surface can say WHICH
 * feature ("planning is paused for your organization") and `refusal` so it can
 * tell a kill-switch from a suspension. A typed, distinguishable refusal — never
 * a crash and never a misleading 402/502.
 */
export class OrgFeatureDisabledError extends Error {
  readonly code = 'ORG_FEATURE_DISABLED' as const;
  constructor(
    readonly organizationId: string,
    readonly key: OrgFeatureFlagKey,
    readonly refusal: 'switched_off' | 'organization_suspended' = 'switched_off',
  ) {
    super(
      refusal === 'organization_suspended'
        ? `This organization is suspended, so ${key} is not available.`
        : `${key} is turned off for this organization.`,
    );
    this.name = 'OrgFeatureDisabledError';
  }
}
