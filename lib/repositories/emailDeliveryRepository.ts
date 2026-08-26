import { Prisma, type EmailDelivery, type EmailDeliveryState } from '@/generated/prisma/client';

// Data access for the transactional-mail delivery record (Bug MOTIR-3507 ·
// Subtask MOTIR-3513). Single-op methods only; writes require `tx` (the
// 4-layer contract). `emailDeliveryService` owns the transactions and the
// error policy.
export const emailDeliveryRepository = {
  /**
   * Insert the row for a message the provider ACCEPTED.
   *
   * Uses the UNCHECKED create input (scalar `workspaceId` FK) rather than a
   * `workspace: { connect }` relation, for the same reason
   * `jobRunRepository.create` does: the job runtime writes under the
   * system-admin context with NO workspace context, so a `connect` — which
   * issues a SELECT on `workspace` to validate the related row — would be
   * hidden by the workspace table's RLS and fail. The scalar FK sets the
   * column directly; referential integrity is still enforced by the Postgres
   * FK constraint, which RLS does not gate.
   */
  async create(
    data: Prisma.EmailDeliveryUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<EmailDelivery> {
    return tx.emailDelivery.create({ data });
  },

  /**
   * Read one delivery by the PROVIDER's id. This is the lookup the delivery
   * webhook (MOTIR-3515) joins an inbound event on, and the one this service
   * uses to return the existing row when a retried send was deduped to the
   * same message.
   */
  async findByProviderMessageId(
    providerMessageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<EmailDelivery | null> {
    return tx.emailDelivery.findUnique({ where: { providerMessageId } });
  },

  /**
   * Every delivery for a set of send keys, for the operator surface
   * (MOTIR-3517). ONE query for a whole page of runs rather than one per row —
   * `idempotency_key` is indexed on this table and on both job ledgers, which
   * is what makes it the join.
   *
   * A read, not a write, but it takes `tx` because the dashboard runs it inside
   * `withWorkspaceContext`: the binding is what scopes it to the caller's
   * workspace under RLS, and reading it off the singleton would silently escape
   * that.
   */
  async listByIdempotencyKeys(
    idempotencyKeys: string[],
    tx: Prisma.TransactionClient,
  ): Promise<EmailDelivery[]> {
    if (idempotencyKeys.length === 0) return [];
    return tx.emailDelivery.findMany({ where: { idempotencyKey: { in: idempotencyKeys } } });
  },

  /**
   * Move one delivery to a new state, stamping when the provider told us
   * (MOTIR-3515). Single-op, as every repository method is: the decision about
   * WHETHER this transition is allowed belongs to `resendWebhookService`, which
   * makes it inside the transaction after locking the row.
   */
  async updateState(
    id: string,
    data: { state: EmailDeliveryState; lastEventAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<EmailDelivery> {
    return tx.emailDelivery.update({ where: { id }, data });
  },

  /**
   * Read a delivery FOR UPDATE, by the provider's id.
   *
   * A read that GUARDS a write, so it takes `tx` and takes the row lock — two
   * events for the same message can arrive concurrently (Resend retries an
   * un-acked delivery while the original is still in flight), and the
   * monotonic-state check is a read-then-write that races without it. Returns
   * the id alone: that is all the caller needs to issue the update, and the
   * state comes back on the same row.
   */
  async lockByProviderMessageId(
    providerMessageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; state: EmailDeliveryState } | null> {
    const rows = await tx.$queryRaw<{ id: string; state: EmailDeliveryState }[]>`
      SELECT "id", "state" FROM "email_delivery"
      WHERE "provider_message_id" = ${providerMessageId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },
};
