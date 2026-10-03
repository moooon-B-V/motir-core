import type { OrgFeatureFlagKey } from '@/lib/featureFlags/registry';

/**
 * One kill-switch of one organization, as the console's Kill-switches table
 * renders it (design `ops.switches.*`, MOTIR-750; the table is MOTIR-752's).
 * One row per REGISTRY key, override or not — `overridden: false` means the org
 * has never been flipped and `enabled` is the platform default.
 */
export interface PlatformOrgFeatureFlagDTO {
  key: OrgFeatureFlagKey;
  /** The STORED state: the override, else the default. A suspension is not folded in. */
  enabled: boolean;
  /** The platform default for this key. */
  defaultEnabled: boolean;
  /** Whether a per-org override row exists. */
  overridden: boolean;
  /** The design's "When OFF" line, from the registry. */
  whenOff: string;
  /** The reason given for the current state; null when never flipped. */
  reason: string | null;
  /** ISO-8601 — "Last changed"; null when never flipped. */
  updatedAt: string | null;
  /** The operator who last flipped it; null when never flipped or account gone. */
  updatedBy: { userId: string; label: string } | null;
}

/** The console's whole kill-switch read for one organization. */
export interface PlatformOrgFeatureFlagsDTO {
  organizationId: string;
  /** A suspended org evaluates every switch OFF, whatever is stored (MOTIR-748). */
  organizationSuspended: boolean;
  flags: PlatformOrgFeatureFlagDTO[];
}
