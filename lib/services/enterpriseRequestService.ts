import { Prisma } from '@/generated/prisma/client';
import { isCloudBilling } from '@/lib/billing/availability';
import { pmTierForOrg } from '@/lib/billing/entitlements';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  EnterpriseRequestOpenError,
  EnterpriseRequestValidationError,
} from '@/lib/billing/errors';
import { enterpriseRequestInputSchema, type EnterpriseRequestDTO } from '@/lib/dto/billing';
import { toEnterpriseRequestDTO } from '@/lib/mappers/billingMappers';
import { orgCan } from '@/lib/organizations/capabilities';
import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { withOrgContext } from '@/lib/organizations/context';
import { enterpriseRequestRepository } from '@/lib/repositories/enterpriseRequestRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationsService } from '@/lib/services/organizationsService';

// The ORG side of an Enterprise request (Story MOTIR-7602 · Subtask MOTIR-7605):
// the Enterprise card's Contact sales sends one, and the card reads the open one
// back so it can say "Request sent" instead of inviting a second.
//
// It shares the billing surface's own gates, so the two never disagree about who
// may act: cloud-only (`BillingNotAvailableError` → 404 off-cloud), a non-member
// is `OrganizationNotFoundError` (→ 404, the no-leak rule), and both sending and
// reading need the `manageBilling` capability — the owner or an admin — which a
// plain member lacks (`BillingForbiddenError` → 403).
//
// ⚠️ ONE OPEN REQUEST PER ORG IS THE DATABASE'S RULE, NOT THIS FILE'S. The
// partial unique index refuses the second open row; this service only translates
// that `P2002` into `EnterpriseRequestOpenError`, after the failed transaction,
// and looks up the request that won so the card can show it. There is no
// read-then-insert to race.
//
// It records and reads. Emailing staff is MOTIR-7606; the console's reads and
// state changes are `platformEnterpriseRequestService` (MOTIR-7608).

/** Who is acting — the signed-in session's user. `email` is the contact default. */
export interface EnterpriseRequestActor {
  userId: string;
  email: string;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** The billing surface's VIEW + MANAGE gate, applied identically to both verbs. */
async function assertBillingManager(actor: EnterpriseRequestActor, organizationId: string) {
  if (!isCloudBilling()) throw new BillingNotAvailableError();
  const access = await organizationsService.resolveOrgAccess(actor.userId, organizationId);
  if (!orgCan(access.role, 'manageBilling')) {
    throw new BillingForbiddenError(
      'Contacting sales is limited to the organization owner and admins.',
    );
  }
}

function parseInput(raw: unknown) {
  const parsed = enterpriseRequestInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new EnterpriseRequestValidationError(field, `${field}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

export const enterpriseRequestService = {
  /**
   * Record the org's Enterprise request. Returns it as the org sees it.
   *
   * Refusals, in order: off-cloud → 404; a non-member → 404; a member without
   * `manageBilling` → 403; an invalid body → 400; the org closing → 409; an
   * open request already there (including one a concurrent send just won) →
   * 409 `ENTERPRISE_REQUEST_OPEN` naming it.
   */
  async create(
    actor: EnterpriseRequestActor,
    organizationId: string,
    rawInput: unknown,
  ): Promise<EnterpriseRequestDTO> {
    await assertBillingManager(actor, organizationId);
    const input = parseInput(rawInput);
    const scope = { userId: actor.userId, organizationId };

    try {
      const row = await withOrgContext(scope, async (tx) => {
        await assertOrgNotClosing(organizationId, tx);
        const tier = pmTierForOrg(
          await organizationRepository.findCapContextInTx(organizationId, tx),
        );
        return enterpriseRequestRepository.create(
          {
            organizationId,
            requestedById: actor.userId,
            cardsPerDay: input.cardsPerDay ?? null,
            parallelAgents: input.parallelAgents ?? null,
            agentPath: input.agentPath ?? null,
            autonomy: input.autonomy ?? null,
            startWhen: input.startWhen ?? null,
            teamSize: input.teamSize ?? null,
            contact: input.contact ? input.contact : actor.email,
            note: input.note,
            tierKeyAtRequest: tier,
          },
          tx,
        );
      });
      return toEnterpriseRequestDTO(row);
    } catch (err) {
      // The partial unique index refused a second open request. The transaction
      // is aborted, so the winner is read in a fresh one.
      if (isUniqueViolation(err)) {
        const open = await withOrgContext(scope, (tx) =>
          enterpriseRequestRepository.findOpenByOrganizationId(organizationId, tx),
        );
        throw new EnterpriseRequestOpenError(open?.id ?? null);
      }
      throw err;
    }
  },

  /** The org's OPEN request, or `null` when none is open. Same gate as create. */
  async getOpen(
    actor: EnterpriseRequestActor,
    organizationId: string,
  ): Promise<EnterpriseRequestDTO | null> {
    await assertBillingManager(actor, organizationId);
    const row = await withOrgContext({ userId: actor.userId, organizationId }, (tx) =>
      enterpriseRequestRepository.findOpenByOrganizationId(organizationId, tx),
    );
    return row ? toEnterpriseRequestDTO(row) : null;
  },
};
