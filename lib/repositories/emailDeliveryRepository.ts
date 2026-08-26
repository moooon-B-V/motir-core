import { Prisma, type EmailDelivery } from '@/generated/prisma/client';

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
};
