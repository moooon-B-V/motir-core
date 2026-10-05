import { Prisma, type EnterpriseRequest } from '@/generated/prisma/client';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
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
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { sendEvent } from '@/lib/jobs/sendEvent';

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
// It records, reads, and — once a request has committed — emails platform staff
// (MOTIR-7606). The console's reads and state changes are
// `platformEnterpriseRequestService` (MOTIR-7608).

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

/**
 * Email every platform staff member about a request that has COMMITTED
 * (MOTIR-7606) — one `email.send` event each, keyed
 * `enterprise-request:<requestId>:<userId>` so a retried send collapses to one
 * delivery per person. Best-effort: a failure is logged and swallowed, because
 * the request is already recorded and the console lists it regardless.
 */
async function notifyStaff(
  row: EnterpriseRequest,
  organizationName: string,
  requesterName: string,
): Promise<void> {
  try {
    const recipients = await platformStaffRepository.listStaffRecipients();
    if (recipients.length === 0) return;
    const requesterEmail = row.requestedById
      ? ((await userRepository.findById(row.requestedById))?.email ?? row.contact)
      : row.contact;
    const requestUrl = `${resolveBaseUrlTrimmed()}/admin/enterprise-requests/${encodeURIComponent(row.id)}`;
    for (const recipient of recipients) {
      await sendEvent('email.send', {
        workspaceId: null,
        idempotencyKey: `enterprise-request:${row.id}:${recipient.id}`,
        to: recipient.email,
        template: 'enterprise-request-received',
        data: {
          organizationName,
          requesterName,
          requesterEmail,
          cardsPerDay: row.cardsPerDay,
          parallelAgents: row.parallelAgents,
          agentPath: row.agentPath,
          autonomy: row.autonomy,
          startWhen: row.startWhen,
          teamSize: row.teamSize,
          contact: row.contact,
          note: row.note,
          requestUrl,
        },
      });
    }
  } catch (err) {
    console.warn('[enterpriseRequest] staff email failed after commit; the request stands', {
      requestId: row.id,
      err,
    });
  }
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

    let committed;
    try {
      committed = await withOrgContext(scope, async (tx) => {
        await assertOrgNotClosing(organizationId, tx);
        const organization = await organizationRepository.findByIdInTx(organizationId, tx);
        const requester = await userRepository.findById(actor.userId, tx);
        const tier = pmTierForOrg(
          await organizationRepository.findCapContextInTx(organizationId, tx),
        );
        const row = await enterpriseRequestRepository.create(
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
        return {
          row,
          organizationName: organization?.name ?? organizationId,
          requesterName: requester?.name || actor.email,
        };
      });
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

    // AFTER the commit, never inside it: a staff email about a request that
    // rolled back would describe nothing, and a mail failure must not undo it.
    await notifyStaff(committed.row, committed.organizationName, committed.requesterName);
    return toEnterpriseRequestDTO(committed.row);
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
