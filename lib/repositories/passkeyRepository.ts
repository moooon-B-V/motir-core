import type { Passkey, Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Data access for the `passkey` table (Story MOTIR-1214 · Subtask MOTIR-3611).
// Single Prisma operations only; no business logic, no transactions of its own
// (CLAUDE.md § 4-layer).
//
// ⚠️ READ-ONLY, AND THAT IS THE WHOLE DESIGN. The table is Better-Auth's — the
// `@better-auth/passkey` adapter creates, renames and deletes the rows through
// `/api/auth/passkey/*`, reached from the browser as `authClient.passkey.*`. A
// write method here would be a SECOND write path onto the same rows, and the
// two would have to agree about the WebAuthn ceremony to stay correct. What the
// plugin does not offer is a read a Server Component can call, because
// `app/(authed)/settings/account/security/page.tsx` resolves its data through
// services in one `Promise.all` rather than fetching its own HTTP endpoints.
// That gap is what these two methods fill, and it is the only gap.

export const passkeyRepository = {
  /**
   * Every passkey a user holds, oldest first.
   *
   * `createdAt` ascending because it is the only order a person can predict:
   * the row they registered first is the row at the top, whether or not they
   * ever named it. There is no other stable key — `name` is nullable and `id`
   * is a cuid.
   *
   * `tx` OPTIONAL: the read has no write to guard, so the `db` singleton is
   * right for the pane's own path; a caller already inside a transaction passes
   * its client so it reads its own uncommitted state.
   */
  async findManyByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<Passkey[]> {
    return (tx ?? db).passkey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  },

  /**
   * How many passkeys a user holds.
   *
   * Its one consumer is the two-factor status read, which needs the NUMBER and
   * not the rows: whether an account is second-factor-satisfied is answered by
   * `count >= 1`, and loading and mapping every credential to decide it would
   * be work thrown away.
   */
  async countByUserId(userId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return (tx ?? db).passkey.count({ where: { userId } });
  },
};
