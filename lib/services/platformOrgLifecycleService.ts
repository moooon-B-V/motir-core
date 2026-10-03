import 'server-only';

import type { PlatformOrganizationDetailDTO } from '@/lib/dto/platform';
import { toPlatformOrganizationDetailDTO } from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import {
  PlatformOrganizationNotFoundError,
  PlatformOrganizationSuspensionStateError,
} from '@/lib/platform/errors';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import { fleetStopService, type FleetStopResult } from '@/lib/services/fleetStopService';

/**
 * ORGANIZATION LIFECYCLE from the platform console — Story 10.3 · MOTIR-748,
 * the backend half of `design/platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-03 — the ops toolkit, Panel 3 (Suspend · Reactivate · status card).
 *
 * Suspension is the NON-PAYMENT / ABUSE lever. Its whole effect lives in ONE
 * column, `organization.suspended_at`, read at request time by the access gate
 * every door already passes through (`organizationsService.resolveWorkspaceAccess`
 * for the cookie session, server actions and OAuth connections;
 * `apiTokensService.verify` for PATs, `motir login` device credentials and run
 * tokens). Nothing is deleted, nothing about a membership or a token changes, so
 * a reactivation restores every door on the next request with nothing to rebuild.
 *
 * ⚠️ BOTH WRITES ARE `superadmin`, asserted HERE as well as in the server action
 * (ADR §2: "the layout protects the PAGES; the service check protects against a
 * future route handler, server action or job that reaches the platform tier
 * without passing through a layout"). §7 puts every per-org write at that degree.
 *
 * ⚠️ THE REASON IS ASSERTED BEFORE THE TRANSACTION OPENS. `withPlatformRead`
 * appends the audit row as its FIRST statement, so a reason checked afterwards
 * would be checked after the row it belongs on — a blank reason must leave no
 * row at all (`platformBillingClassificationService.setInternalBilling`'s rule).
 * The typed-slug confirmation the design adds on Suspend is a UI-only guard; the
 * reason is the server-side one.
 *
 * ⚠️ THE ROW IS LOCKED AND RE-READ. Suspending a suspended org (or reactivating an
 * active one) is a REFUSAL thrown inside the transaction, which rolls the audit
 * row back: two operators racing produce one change and one refusal, never two
 * audit rows describing one change.
 *
 * ⚠️ PLATFORM STAFF KEEP THEIR ACCESS. The console reads organizations through
 * `withPlatformRead` (the `app.platform_staff` arms), never through the tenant
 * access gate, so a suspended org stays fully visible and operable here — that
 * is how it gets reactivated.
 */

/** What a suspend returns: the organization as the console renders it, plus what
 *  stopping its CI fleet did (design `ops.suspend.c2` — "running ones are
 *  stopped"). `fleetStop` is null when the stop itself could not run; it is
 *  best-effort AFTER the suspension committed and never undoes it. */
export interface PlatformOrganizationSuspendResultDTO {
  organization: PlatformOrganizationDetailDTO;
  fleetStop: FleetStopResult | null;
}

export const platformOrgLifecycleService = {
  /**
   * Suspend an organization. Audited `org.suspend`, reason required.
   *
   * After the suspension COMMITS, the org's CI fleet is stopped through the same
   * `fleetStopService.stopOrganization` the zero-credit stop uses, with the
   * `admin_stop` reason it reserves for a platform halt. That is outside the
   * transaction on purpose: it calls GitHub and the container provider, and a
   * provider outage must not prevent the suspension — the gate already refuses
   * every member and every token, including a running agent's run token.
   */
  async suspend(
    principal: PlatformPrincipal,
    organizationId: string,
    reason: string,
  ): Promise<PlatformOrganizationSuspendResultDTO> {
    await requirePlatformStaff('superadmin');
    const entry = {
      action: 'org.suspend' as const,
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason,
    };
    assertReasonSatisfied(entry);

    const row = await withPlatformRead(principal, entry, async (tx) => {
      const locked = await platformOrganizationRepository.lockSuspension(organizationId, tx);
      if (!locked) throw new PlatformOrganizationNotFoundError(organizationId);
      if (locked.suspendedAt) throw new PlatformOrganizationSuspensionStateError(true);
      return platformOrganizationRepository.setSuspended(
        organizationId,
        { suspendedAt: new Date(), reason: reason.trim(), suspendedByUserId: principal.userId },
        tx,
      );
    });

    let fleetStop: FleetStopResult | null = null;
    try {
      fleetStop = await fleetStopService.stopOrganization(organizationId, 'admin_stop');
    } catch (err) {
      console.error(
        '[platformOrgLifecycleService] the suspended organization’s fleet stop failed',
        {
          organizationId,
          detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
        },
      );
    }

    return { organization: toPlatformOrganizationDetailDTO(row), fleetStop };
  },

  /**
   * Reactivate a suspended organization. Audited `org.reactivate`, reason
   * required. Its members are admitted on their next request; kill-switches
   * (MOTIR-750) keep whatever state they had — reactivating touches only the
   * suspension columns.
   */
  async reactivate(
    principal: PlatformPrincipal,
    organizationId: string,
    reason: string,
  ): Promise<PlatformOrganizationDetailDTO> {
    await requirePlatformStaff('superadmin');
    const entry = {
      action: 'org.reactivate' as const,
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason,
    };
    assertReasonSatisfied(entry);

    const row = await withPlatformRead(principal, entry, async (tx) => {
      const locked = await platformOrganizationRepository.lockSuspension(organizationId, tx);
      if (!locked) throw new PlatformOrganizationNotFoundError(organizationId);
      if (!locked.suspendedAt) throw new PlatformOrganizationSuspensionStateError(false);
      return platformOrganizationRepository.clearSuspended(organizationId, tx);
    });

    return toPlatformOrganizationDetailDTO(row);
  },
};
