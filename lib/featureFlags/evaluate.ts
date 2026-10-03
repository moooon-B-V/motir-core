import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';
import {
  defaultOrgFeatureFlags,
  isOrgFeatureFlagKey,
  type OrgFeatureFlagKey,
} from '@/lib/featureFlags/registry';
import {
  orgFeatureFlagRepository,
  type OrgFeatureState,
} from '@/lib/repositories/orgFeatureFlagRepository';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * THE HOT-PATH EVALUATION of the per-org kill-switches (Story 10.3 · MOTIR-750).
 *
 * A leaf module, like `lib/organizations/closingGuard.ts`, so every entry point
 * can ask without importing the platform tier: one indexed statement against
 * motir-core's own database (the org row LEFT JOIN its override rows), no cache
 * to go stale and no external round trip. A flip therefore takes effect on the
 * org's NEXT request, with no deploy — the design's `ops.switches.subtitle`.
 *
 * Evaluation: the org's override, else the registry default. A SUSPENDED org
 * (MOTIR-748) evaluates every switch OFF, without touching its stored overrides —
 * the actorless paths (an auto re-run, a review run, a planning cadence) never
 * pass the member access gate, and this is where they meet the suspension.
 *
 * Read under the SYSTEM context: several callers bind no user, and
 * `org_feature_flag` admits reads to `app.system_admin` (and to platform staff)
 * only. An unknown org (or workspace) evaluates to the defaults — the safe
 * reading for a caller that will fail on its own missing row a moment later.
 */

export type OrgFeatureFlags = Record<OrgFeatureFlagKey, boolean> & {
  /** The org these were evaluated for, or null when it could not be resolved. */
  organizationId: string | null;
  /** True when the org is suspended — every switch then reads false. */
  suspended: boolean;
};

function evaluateState(state: OrgFeatureState | null): OrgFeatureFlags {
  const flags = defaultOrgFeatureFlags();
  if (!state) return { ...flags, organizationId: null, suspended: false };
  for (const row of state.flags) {
    if (isOrgFeatureFlagKey(row.key)) flags[row.key] = row.enabled;
  }
  const suspended = state.suspendedAt !== null;
  if (suspended) {
    for (const key of Object.keys(flags) as OrgFeatureFlagKey[]) flags[key] = false;
  }
  return { ...flags, organizationId: state.organizationId, suspended };
}

/** Every switch of one organization, evaluated. */
export async function evaluateOrgFeatureFlags(organizationId: string): Promise<OrgFeatureFlags> {
  const state = await withSystemContext((tx) =>
    orgFeatureFlagRepository.readStateByOrganizationId(organizationId, tx),
  );
  return evaluateState(state);
}

/** Every switch of the organization owning `workspaceId`, evaluated. */
export async function evaluateWorkspaceFeatureFlags(workspaceId: string): Promise<OrgFeatureFlags> {
  const state = await withSystemContext((tx) =>
    orgFeatureFlagRepository.readStateByWorkspaceId(workspaceId, tx),
  );
  return evaluateState(state);
}

/** Throw the typed refusal when `key` is off in `flags`. */
export function assertFlagOn(flags: OrgFeatureFlags, key: OrgFeatureFlagKey): void {
  if (flags[key] || flags.organizationId === null) return;
  throw new OrgFeatureDisabledError(
    flags.organizationId,
    key,
    flags.suspended ? 'organization_suspended' : 'switched_off',
  );
}

/** Refuse with {@link OrgFeatureDisabledError} when `key` is off for the org. */
export async function assertOrgFeatureEnabled(
  organizationId: string,
  key: OrgFeatureFlagKey,
): Promise<void> {
  assertFlagOn(await evaluateOrgFeatureFlags(organizationId), key);
}

/** Refuse when `key` is off for the organization owning `workspaceId`. */
export async function assertWorkspaceFeatureEnabled(
  workspaceId: string,
  key: OrgFeatureFlagKey,
): Promise<void> {
  assertFlagOn(await evaluateWorkspaceFeatureFlags(workspaceId), key);
}
