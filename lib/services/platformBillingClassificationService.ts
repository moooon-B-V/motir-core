import 'server-only';

import type {
  PlatformOrganizationDetailDTO,
  PlatformOrganizationPageDTO,
  PlatformOrganizationSummaryDTO,
} from '@/lib/dto/platform';
import {
  toPlatformAuditLogDTO,
  toPlatformOrganizationDetailDTO,
  toPlatformOrganizationSummaryDTO,
} from '@/lib/mappers/platformMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import {
  PlatformClassificationStateError,
  PlatformOrganizationNotFoundError,
} from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { isPlatformAuditAction, reasonPolicyFor } from '@/lib/platform/auditActions';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The INTERNAL-BILLING classification — Story MOTIR-4337 · MOTIR-4565, and the
 * backend half of design `platform-admin/design-notes.md` Panels 10–12.
 *
 * An organization classified `internalBilling` is charged EXACTLY like a
 * customer and then made whole: every debit lands, and each is paired in the
 * same transaction with an offsetting credit, so the balance nets to zero while
 * both entries stay visible
 * (`docs/decisions/internal-billing-classification.md` §2–§3). This service owns
 * the FLAG — the offset itself is motir-ai's, and the surfaces that stop
 * branching on `isMeta` are their own cards.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SERVICE DELIBERATELY DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 * `isMeta` keeps its shipped meaning and gains no third one — `entitlementsService`,
 * `billingService.getAiAccess`, `lib/billing/aiEntitlement.ts` and the CI
 * allowance bypass are all unchanged. §9.1 of
 * `docs/decisions/code-graph-index-fleet.md` warns in writing against
 * overloading that flag, and the ADR §1 quotes it as the reason there are two
 * columns rather than one. Nothing here lifts a cap or grants an entitlement.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, PER METHOD
 * ---------------------------------------------------------------------------
 * `support` reads, `superadmin` writes — ADR §7's allocation table, applied here
 * rather than inherited from the `(admin)` layout. §2 is explicit that BOTH
 * assertions are required: *"the layout protects the PAGES; the service check
 * protects against a future route handler, server action or job that reaches the
 * platform tier without passing through a layout."*
 *
 * ⚠️ THE WRITE IS `superadmin`, ONE DEGREE ABOVE MOTIR-1167's TWO. Those act on
 * one person's account and their blast radius is an email or a session set; this
 * changes what an organization is BILLED, which is the class §7's table puts at
 * `superadmin` for every other member (credit grants, tier assignment, per-org
 * flags). A classification is a per-org billing flag by any reading, so it takes
 * that degree rather than the one that happens to be convenient.
 *
 * ---------------------------------------------------------------------------
 * WHY THE READS RETURN ANYTHING AT ALL
 * ---------------------------------------------------------------------------
 * `organization` runs FORCE ROW LEVEL SECURITY and, until
 * `20260905120000_organization_internal_billing`, not one of its policies
 * mentioned `app.platform_staff` — `lib/platform/context.ts` says so in as many
 * words. A read from this tier would have returned ZERO ROWS and raised nothing.
 * The two arms that migration adds are what make this file's answers real, which
 * is also why every method routes through `withPlatformRead` (the only thing
 * that binds the GUC) and never through the `db` singleton.
 */

/**
 * How many organizations one lookup returns.
 *
 * A hard cap, not a page — the same argument the account lookup makes: the
 * answer to "too many matches" is a narrower query, not a pager an operator
 * scrolls through reading every tenant Motir hosts.
 */
export const PLATFORM_ORG_SEARCH_LIMIT = 20;

/**
 * The shortest query the lookup will run.
 *
 * Enforced in the SERVICE rather than by the form, because a Server Action is
 * reachable without the form. Two characters, one lower than the account
 * lookup's three: an org slug is routinely short (`acme`, `moooon`) and the
 * population is orders of magnitude smaller than the account table's.
 */
export const PLATFORM_ORG_SEARCH_MIN_LENGTH = 2;

/** How many audit rows the org page reads before filtering to the writes. */
const PLATFORM_ORG_ACTION_LOG_LIMIT = 50;

/**
 * Is this row an operator WRITE, as the page's log means the word?
 *
 * ⚠️ THE DISCRIMINATOR IS THE REASON POLICY, NOT A LIST OF ACTION NAMES —
 * `platformSupportService`'s rule, and it is quoted rather than re-derived
 * because a second copy would drift. The ADR requires a stated reason for every
 * write and forbids one on every read (§3b), so `reason: 'required'` IS "this
 * action changed something"; a hard-coded list would need editing every time a
 * later story adds a verb, with the log silently omitting the new one.
 *
 * A row whose action THIS BUILD does not recognise is EXCLUDED: the column is a
 * `String`, so a newer deploy can write a member this build has never heard of,
 * and excluding it under-reports where including it would assert that a write
 * happened on the strength of not recognising the name.
 */
function isOperatorWrite(row: { action: string }): boolean {
  return isPlatformAuditAction(row.action) && reasonPolicyFor(row.action) === 'required';
}

export const platformBillingClassificationService = {
  /**
   * Find organizations by name or slug.
   *
   * Returns `[]` for a query under the floor rather than throwing: an empty box
   * and a one-character box are the same intent — the operator has not finished
   * typing — and the surface renders both as its "search for an organization"
   * state (design Panel 10b).
   */
  async searchOrganizations(
    principal: PlatformPrincipal,
    query: string,
  ): Promise<PlatformOrganizationSummaryDTO[]> {
    await requirePlatformStaff('support');
    const trimmed = query.trim();
    if (trimmed.length < PLATFORM_ORG_SEARCH_MIN_LENGTH) return [];

    const rows = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'organization', targetLabel: trimmed },
      (tx) =>
        platformOrganizationRepository.searchOrganizations(trimmed, PLATFORM_ORG_SEARCH_LIMIT, tx),
    );
    return rows.map(toPlatformOrganizationSummaryDTO);
  },

  /**
   * One organization, as the org page's header renders it.
   *
   * ⚠️ THE NOT-FOUND IS THROWN INSIDE THE TRANSACTION, not after it. The audit
   * row is already written by the time this callback runs, so returning a
   * sentinel and throwing outside would COMMIT a row recording a read of an org
   * that does not exist. Throwing here rolls the row back with the read — ADR
   * §3a from the other side: *"a read that rolls back leaves no audit row."*
   */
  async getOrganization(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrganizationDetailDTO> {
    await requirePlatformStaff('support');

    const row = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'organization', targetId: organizationId },
      async (tx) => {
        const found = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!found) throw new PlatformOrganizationNotFoundError(organizationId);
        return found;
      },
    );

    return toPlatformOrganizationDetailDTO(row);
  },

  /**
   * The whole ORG PAGE — the organization AND every operator write on it.
   *
   * ONE method returning both, so the page costs ONE platform transaction and
   * writes ONE audit row. Two methods would write two rows per page view and put
   * the trail's own noise floor above the actions it exists to record — the
   * argument `getUserPage` makes, and the reason this is not two calls from the
   * page.
   *
   * ⚠️ THE TRAIL IS WHAT MAKES THE CONTROL HONEST (MOTIR-4568 criterion 4). The
   * console's standing line is that *"an operator can never perform an action and
   * wonder whether it was recorded"*, and the way to keep it is to render the row
   * the write just produced on the surface that produced it. A control whose
   * record lived on some other screen would be a promise of accountability that
   * is decoration.
   */
  async getOrganizationPage(
    principal: PlatformPrincipal,
    organizationId: string,
  ): Promise<PlatformOrganizationPageDTO> {
    await requirePlatformStaff('support');

    const result = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'organization', targetId: organizationId },
      async (tx) => {
        const row = await platformOrganizationRepository.findOrganizationById(organizationId, tx);
        if (!row) throw new PlatformOrganizationNotFoundError(organizationId);
        const trail = await platformAuditLogRepository.listByTarget(
          'organization',
          organizationId,
          PLATFORM_ORG_ACTION_LOG_LIMIT,
          tx,
        );
        return { row, trail };
      },
    );

    return {
      organization: toPlatformOrganizationDetailDTO(result.row),
      actions: result.trail.filter(isOperatorWrite).map(toPlatformAuditLogDTO),
    };
  },

  /**
   * Classify an organization internal, or remove the classification.
   *
   * ONE method for both directions, because they are one toggle in the design
   * and — more to the point — one invariant: an org is classified or it is not,
   * and the check that it is not already in the requested state is the same
   * lock-and-re-read in both directions. Two methods would be two copies of the
   * concurrency guard, and the second copy is the one that gets it wrong.
   * `platformSupportService.setSuspended` is the shipped precedent for that
   * argument as well as for this shape.
   *
   * ⚠️ THE ROW IS LOCKED AND RE-READ INSIDE THE TRANSACTION. This is a
   * read-derived write: whether to write at all depends on the state read a
   * moment earlier. Without `FOR UPDATE` two operators acting on one org during
   * the same conversation both read "not classified", both write, and the log
   * carries two classifications while only one of them describes a change that
   * happened.
   *
   * ⚠️ AND THE REASON IS ASSERTED BEFORE THE TRANSACTION OPENS. Both new audit
   * actions are `reason: 'required'`, and `withPlatformRead` writes the audit row
   * as its FIRST statement — so a reason checked afterwards would be checked
   * after the row it belongs on had already been written. Refusing first means a
   * blank reason leaves no row at all, which is criterion 5's whole point.
   *
   * Removing the classification leaves every ledger row exactly where it is. The
   * debits and their offsets are history; the flag governs what happens NEXT.
   */
  async setInternalBilling(
    principal: PlatformPrincipal,
    organizationId: string,
    internalBilling: boolean,
    reason: string,
  ): Promise<PlatformOrganizationDetailDTO> {
    await requirePlatformStaff('superadmin');
    const entry = {
      action: internalBilling
        ? ('org.internal_billing_set' as const)
        : ('org.internal_billing_unset' as const),
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason,
    };
    assertReasonSatisfied(entry);

    const row = await withPlatformRead(principal, entry, async (tx) => {
      const locked = await platformOrganizationRepository.lockInternalBilling(organizationId, tx);
      // Both refusals are thrown from INSIDE, which rolls the audit row back with
      // them. A row recording a classification that was refused is worse than no
      // row: it is the trail asserting something about the org that the org
      // itself contradicts.
      if (!locked) throw new PlatformOrganizationNotFoundError(organizationId);
      if (locked.internalBilling === internalBilling) {
        throw new PlatformClassificationStateError(internalBilling);
      }

      return platformOrganizationRepository.setInternalBilling(organizationId, internalBilling, tx);
    });

    return toPlatformOrganizationDetailDTO(row);
  },
};
