import 'server-only';

import type {
  PlatformOrgFeatureFlagDTO,
  PlatformOrgFeatureFlagsDTO,
} from '@/lib/dto/platformFeatureFlags';
import {
  assertOrgFeatureEnabled,
  assertWorkspaceFeatureEnabled,
  evaluateOrgFeatureFlags,
} from '@/lib/featureFlags/evaluate';
import {
  ORG_FEATURE_FLAG_KEYS,
  isOrgFeatureFlagKey,
  type OrgFeatureFlagKey,
} from '@/lib/featureFlags/registry';
import { toPlatformOrgFeatureFlagDTO } from '@/lib/mappers/platformFeatureFlagMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import {
  PlatformFeatureFlagStateError,
  PlatformOrganizationNotFoundError,
  PlatformUnknownFeatureFlagError,
} from '@/lib/platform/errors';
import { orgFeatureFlagRepository } from '@/lib/repositories/orgFeatureFlagRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * PER-ORGANIZATION KILL-SWITCHES — Story 10.3 · MOTIR-750, the backend half of
 * the design's Kill-switches panel (`platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-03, `ops.switch.*`; the panel itself is MOTIR-752's).
 *
 * Two audiences, two halves:
 *
 * - **The hot path** (`isEnabled` / `assertEnabled` / `assertEnabledForWorkspace`)
 *   — called by the entry points each switch guards. Delegates to
 *   `lib/featureFlags/evaluate.ts`: one indexed statement, no external round
 *   trip, "override, else the registry default", a suspended org reads OFF.
 * - **The console** (`listForOrganization` / `setFlag`) — the platform tier.
 *   `support` reads; `superadmin` writes (ADR §7's "per-org feature flags /
 *   kill-switches" row), asserted here AND in the server action.
 *
 * ⚠️ THE KEY IS VALIDATED AND THE REASON ASSERTED BEFORE THE TRANSACTION OPENS:
 * `withPlatformRead` appends the audit row first, so an unknown key or a blank
 * reason must be refused before there is a row to roll back.
 *
 * ⚠️ THE ORGANIZATION ROW IS THE LOCK. A first flip has no override row to lock
 * (`FOR UPDATE` over zero rows locks nothing), so two operators flipping the same
 * switch would both read "default" and both write. Locking the org row
 * serialises every flip of every switch of that org, and the no-op refusal is
 * decided on the committed state.
 */
export const featureFlagService = {
  /** Whether `key` is on for the organization — override, else default; off when suspended. */
  async isEnabled(organizationId: string, key: OrgFeatureFlagKey): Promise<boolean> {
    return (await evaluateOrgFeatureFlags(organizationId))[key];
  },

  /** Refuse with `OrgFeatureDisabledError` (→ 403 `ORG_FEATURE_DISABLED`) when off. */
  assertEnabled(organizationId: string, key: OrgFeatureFlagKey): Promise<void> {
    return assertOrgFeatureEnabled(organizationId, key);
  },

  /** {@link assertEnabled} for the organization owning `workspaceId`. */
  assertEnabledForWorkspace(workspaceId: string, key: OrgFeatureFlagKey): Promise<void> {
    return assertWorkspaceFeatureEnabled(workspaceId, key);
  },

  /**
   * The console read: one row per REGISTRY key, override or default. An audited
   * `estate.read` (`metadata.surface = 'kill_switches'`); `support` and up.
   */
  async listForOrganization(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrgFeatureFlagsDTO> {
    await requirePlatformStaff('support');
    const { org, rows } = await withPlatformRead(
      principal,
      {
        action: 'estate.read',
        targetKind: 'organization',
        targetId: organizationId,
        organizationId,
        metadata: { surface: 'kill_switches' },
      },
      async (tx) => {
        const found = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!found) throw new PlatformOrganizationNotFoundError(organizationId);
        return {
          org: found,
          rows: await orgFeatureFlagRepository.listByOrganization(organizationId, tx),
        };
      },
    );
    return {
      organizationId,
      organizationSuspended: org.suspendedAt !== null,
      flags: ORG_FEATURE_FLAG_KEYS.map((key) =>
        toPlatformOrgFeatureFlagDTO(key, rows.find((r) => r.key === key) ?? null),
      ),
    };
  },

  /**
   * Flip one switch for one organization. ONE transaction: the audited
   * `org.kill_switch_off` / `org.kill_switch_on` row (metadata `{ key, enabled }`),
   * the org-row lock, the no-op refusal, the override upsert. `superadmin`,
   * reason required, unknown key refused. Takes effect on the org's next request.
   */
  async setFlag(
    principal: PlatformPrincipal,
    organizationId: string,
    key: string,
    enabled: boolean,
    reason: string,
  ): Promise<PlatformOrgFeatureFlagDTO> {
    await requirePlatformStaff('superadmin');
    if (!isOrgFeatureFlagKey(key)) throw new PlatformUnknownFeatureFlagError(key);
    const entry = {
      action: enabled ? ('org.kill_switch_on' as const) : ('org.kill_switch_off' as const),
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason,
      metadata: { key, enabled },
    };
    assertReasonSatisfied(entry);

    const row = await withPlatformRead(principal, entry, async (tx) => {
      const locked = await platformOrganizationRepository.lockOrganization(organizationId, tx);
      if (!locked) throw new PlatformOrganizationNotFoundError(organizationId);
      const current = await orgFeatureFlagRepository.findByOrgAndKey(organizationId, key, tx);
      const effective = current ? current.enabled : toPlatformOrgFeatureFlagDTO(key, null).enabled;
      if (effective === enabled) throw new PlatformFeatureFlagStateError(key, enabled);
      return orgFeatureFlagRepository.upsert(
        { organizationId, key, enabled, reason: reason.trim(), updatedByUserId: principal.userId },
        tx,
      );
    });
    return toPlatformOrgFeatureFlagDTO(key, row);
  },
};
