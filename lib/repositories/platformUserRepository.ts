import { Prisma, type User } from '@/generated/prisma/client';

/**
 * Cross-tenant ACCOUNT access for the operator console — the platform tier's
 * repository layer (`docs/decisions/platform-staff-auth.md` §3, MOTIR-1167).
 *
 * ⚠️ EVERY METHOD TAKES `tx` AS A REQUIRED PARAMETER, READS INCLUDED — one step
 * stricter than `CLAUDE.md`'s read-method rule allows, and for the same reason
 * `platformAuditLogRepository` is: the only thing that opens a platform
 * transaction is `withPlatformRead`, and the only thing that writes the audit
 * row is opening one. A read issued on the `db` singleton would be a
 * cross-tenant read with no trail, and the ADR's §3a claim — *"a read that
 * commits cannot exist without [an audit row]"* — would be a convention instead
 * of a property. Requiring `tx` makes the untrailed read a compile error.
 *
 * ⚠️ NO TENANT FILTER, and that absence is the thing being reviewed rather than
 * a bug to be caught (§3's layer table says so in as many words). These methods
 * see every account Motir hosts. What confines them is that they are reachable
 * only from `lib/services/platform*Service.ts`, each of whose public methods
 * takes a `PlatformPrincipal` and re-asserts the ladder.
 *
 * ⚠️ AND THE TABLE IT READS HAS NO RLS — deliberately, and stably. `user` and
 * `session` are both in `tests/tenant-root-creation-rls.test.ts`'s
 * DELIBERATELY_UNGUARDED map (*"the global identity; users are not
 * workspace-scoped"*), which is why the day-1 operator tools answer identically
 * before and after MOTIR-2435's cutover to the non-bypass role. Do NOT extend
 * this repository to a TENANT table on that reasoning: those have policies, none
 * of them has a `platform_staff` arm, and adding the arms is MOTIR-730's card.
 * A tenant read from here would return zero rows and raise nothing the day the
 * cutover lands (the MOTIR-2880 shape).
 */
export const platformUserRepository = {
  /**
   * Find accounts by email or name, newest first.
   *
   * A case-insensitive `contains` on two columns, which is the shape of every
   * lookup box in the product and is what an operator holding half an email
   * address out of a support message actually has. It is NOT indexed and is not
   * meant to be: the console is used by a handful of humans, and the alternative
   * (a trigram index on the identity table) is a write cost on every signup for
   * a query that runs a few times a day.
   *
   * `take` is a hard cap rather than a page: the lookup's answer to "too many
   * matches" is a narrower query, not a pager an operator scrolls through
   * reading strangers' email addresses.
   */
  async search(query: string, take: number, tx: Prisma.TransactionClient): Promise<User[]> {
    return tx.user.findMany({
      where: {
        OR: [
          { email: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  },

  /** One account by id, or null. */
  async findById(userId: string, tx: Prisma.TransactionClient): Promise<User | null> {
    return tx.user.findUnique({ where: { id: userId } });
  },

  /**
   * Lock the account row and return its CURRENT suspension state.
   *
   * ⚠️ THE LOCK IS THE POINT, not the read. Suspending is a read-derived write —
   * the decision to write depends on the state read a moment earlier — so
   * without `FOR UPDATE` two concurrent operators both read "open", both write,
   * and the log carries two suspensions of one account while the column silently
   * keeps whichever reason committed last. `CLAUDE.md`'s repository rule names
   * exactly this case: *"reads that guard a subsequent write take `tx` and use
   * `SELECT FOR UPDATE` via `$queryRaw` when concurrent writes could race on the
   * same row."*
   *
   * Returns `null` when the id names no account, so the caller can tell "gone"
   * from "open" without a second read.
   */
  async lockSuspensionState(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ suspendedAt: Date | null } | null> {
    const rows = await tx.$queryRaw<{ suspended_at: Date | null }[]>`
      SELECT "suspended_at" FROM "user" WHERE "id" = ${userId} FOR UPDATE
    `;
    const row = rows[0];
    return row ? { suspendedAt: row.suspended_at } : null;
  },

  /** Set or clear the suspension columns. */
  async setSuspension(
    userId: string,
    suspension: { suspendedAt: Date | null; suspendedReason: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    return tx.user.update({ where: { id: userId }, data: suspension });
  },

  /**
   * Delete every session the account holds, and report how many went.
   *
   * This is the half of a suspension that takes effect NOW: the column stops the
   * NEXT sign-in, and this stops the sessions already open. The design states
   * both in the confirm dialog's own words — *"They are signed out of every
   * session immediately and cannot sign back in"* — and a suspension that did
   * only the first would leave an already-signed-in abuser working for up to the
   * session lifetime, which is the one window the action exists to close.
   */
  async deleteSessions(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.session.deleteMany({ where: { userId } });
    return result.count;
  },

  /** How many sessions the account currently holds — the drill-down's figure. */
  async countSessions(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.session.count({ where: { userId } });
  },
};
