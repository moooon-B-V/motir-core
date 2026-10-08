import {
  type EnterpriseRequest,
  type EnterpriseRequestStatus,
  type Prisma,
} from '@/generated/prisma/client';

// Data access for `enterprise_request` (Story MOTIR-7602 · Subtask MOTIR-7605) —
// one row per Contact-sales request an org sends from Billing & plans.
//
// Single Prisma operations only; no business logic, no transactions of its own
// (CLAUDE.md § 4-layer). The POLICY — who may send, what the org may see, which
// state follows which — belongs to `enterpriseRequestService` (the org side)
// and `platformEnterpriseRequestService` (the console side, MOTIR-7608).
//
// ⚠️ EVERY METHOD TAKES `tx`, INCLUDING THE READS. The table is RLS-gated on
// `app.organization_id` / `app.platform_staff` / `app.system_admin`, GUCs only a
// context TRANSACTION binds. A read on the `db` singleton sees NULL and returns
// ZERO rows while raising nothing — which here reads as "nothing was asked".

/** The open states — the ones the partial unique index allows one of per org. */
export const OPEN_ENTERPRISE_REQUEST_STATUSES = ['new', 'contacted', 'offer_sent'] as const;

/** The fields a caller supplies when recording a request. `status` defaults to
 *  `new`; `contact` is already defaulted by the service. */
export interface EnterpriseRequestCreateInput {
  organizationId: string;
  requestedById: string;
  cardsPerDay: number | null;
  parallelAgents: number | null;
  agentPath: EnterpriseRequest['agentPath'];
  autonomy: EnterpriseRequest['autonomy'];
  startWhen: EnterpriseRequest['startWhen'];
  teamSize: EnterpriseRequest['teamSize'];
  contact: string;
  note: string;
  tierKeyAtRequest: string | null;
}

/** A request with the org's name and the requester's display fields — the console's row. */
export type EnterpriseRequestWithParties = Prisma.EnterpriseRequestGetPayload<{
  include: {
    organization: { select: { name: true } };
    requestedBy: { select: { id: true; name: true; email: true } };
  };
}>;

const WITH_PARTIES = {
  organization: { select: { name: true } },
  requestedBy: { select: { id: true, name: true, email: true } },
} as const;

export const enterpriseRequestRepository = {
  /**
   * Record one request.
   *
   * ⚠️ THE UNIQUE VIOLATION IS THE GUARD, AND IT IS THE CALLER'S TO TRANSLATE.
   * `enterprise_request_open_per_org_key` is a PARTIAL unique index on
   * `(organization_id) WHERE status IN ('new','contacted','offer_sent')`, so a
   * second insert for an org that already has an open request throws a raw
   * Prisma `P2002` — including the loser of two concurrent sends, which no
   * read-then-insert could stop. The service catches it OUTSIDE its transaction
   * and rethrows `EnterpriseRequestOpenError`.
   */
  async create(
    input: EnterpriseRequestCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<EnterpriseRequest> {
    return tx.enterpriseRequest.create({ data: input });
  },

  /**
   * This org's OPEN request, or null. `findFirst`, because the one-open rule is a
   * PARTIAL unique index Prisma cannot model; newest first so the answer is
   * deterministic even if the index were ever absent.
   */
  async findOpenByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EnterpriseRequest | null> {
    return tx.enterpriseRequest.findFirst({
      where: { organizationId, status: { in: [...OPEN_ENTERPRISE_REQUEST_STATUSES] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** One request by id, whatever its state. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<EnterpriseRequest | null> {
    return tx.enterpriseRequest.findUnique({ where: { id } });
  },

  /** One request by id with its org and requester (the console's detail). */
  async findByIdWithParties(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<EnterpriseRequestWithParties | null> {
    return tx.enterpriseRequest.findUnique({ where: { id }, include: WITH_PARTIES });
  },

  /**
   * One page of requests in `statuses` (every state when null), newest first,
   * keyset-paged AFTER the row `afterId` (exclusive). `take` is the caller's
   * page size plus one, so the caller can tell whether another page exists.
   */
  async listPage(
    statuses: readonly EnterpriseRequestStatus[] | null,
    afterId: string | null,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<EnterpriseRequestWithParties[]> {
    return tx.enterpriseRequest.findMany({
      where: statuses ? { status: { in: [...statuses] } } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: WITH_PARTIES,
      take,
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
    });
  },

  /** How many requests stand in each state, across every org. */
  async countByStatus(
    tx: Prisma.TransactionClient,
  ): Promise<{ status: EnterpriseRequestStatus; count: number }[]> {
    const rows = await tx.enterpriseRequest.groupBy({ by: ['status'], _count: { _all: true } });
    return rows.map((r) => ({ status: r.status, count: r._count._all }));
  },

  /**
   * Move a request from `from` to `to` ONLY if it is still in `from`, and
   * return how many rows moved (0 or 1). The condition is the race guard: two
   * staff moving one request at once both issue this, the second blocks on the
   * row lock until the first commits, re-evaluates `status = from`, and moves
   * nothing. No read-then-write can stop that; the WHERE clause does.
   */
  async transitionIf(
    id: string,
    from: EnterpriseRequestStatus,
    to: EnterpriseRequestStatus,
    closedAt: Date | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.enterpriseRequest.updateMany({
      where: { id, status: from },
      data: { status: to, closedAt },
    });
    return result.count;
  },
};
