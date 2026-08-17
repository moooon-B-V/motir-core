import { type PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';

/**
 * Platform-staff standing, read off the `user` row.
 *
 * A READ-ONLY repository on a table with no RLS (`user` is in
 * `tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED map — "the global
 * identity; users are not workspace-scoped"), so the `db` singleton is the
 * correct client here per `CLAUDE.md`'s read-method rule. There is no tenant to
 * bind: the whole question this answers is about standing OUTSIDE every tenant.
 *
 * ⚠️ Read FRESH per request, never cached into the session (ADR §1). The
 * `platformRole` column is deliberately NOT a Better-Auth `additionalFields`
 * entry: a revoked operator must lose access on their NEXT REQUEST, not on
 * their next sign-in. `requirePlatformStaff` wraps this call in React `cache()`
 * for per-request dedupe, which is the only memoisation this value may have.
 */
export const platformStaffRepository = {
  /**
   * The user's platform standing and the email the console footer renders, or
   * `null` when the id names no user.
   *
   * Selects three columns and no more. A platform principal is an identity
   * assertion, not a user profile — nothing downstream needs the rest of the
   * row, and a `findUnique` with no `select` would hand the gate columns it has
   * no business carrying into a layout.
   */
  async findStandingByUserId(
    userId: string,
  ): Promise<{ id: string; email: string; platformRole: PlatformRole | null } | null> {
    return db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, platformRole: true },
    });
  },
};
