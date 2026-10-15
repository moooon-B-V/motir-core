import 'server-only';

import { type PlatformRole } from '@/generated/prisma/client';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';

// The jobs dashboard's platform-staff gate, in ONE place (MOTIR-8197).
//
// The System tab and the workspace-less dead-letter replay used to be granted
// to whoever's email matched `PLATFORM_ADMIN_EMAIL` — a stopgap until real
// platform-admin roles existed. Those roles ship (`User.platformRole`,
// `docs/decisions/platform-staff-auth.md`), so the two levels the jobs surface
// asks for are named here once and read from the account's standing, fresh on
// every request.

/** Seeing the System tab — the cross-tenant job ledger is a `support` read. */
export const JOBS_SYSTEM_READ_ROLE: PlatformRole = 'support';

/**
 * Replaying a workspace-less dead letter — it runs under `withSystemContext`,
 * which bypasses tenant RLS, so it is an `operator` write.
 */
export const JOBS_SYSTEM_REPLAY_ROLE: PlatformRole = 'operator';

/**
 * The request user's platform role, or `null` when they have none.
 *
 * Request-scoped: `requirePlatformStaff` reads the session and the user row
 * fresh (cached per request only), so a revoked role stops answering on the
 * next request. Its 404-shaped `NotPlatformStaffError` — no session, a tenant
 * user, an owner at any tier — becomes `null` here and nowhere else; anything
 * else it throws is a real failure and is rethrown.
 */
export async function resolveJobsPlatformRole(): Promise<PlatformRole | null> {
  try {
    const principal = await requirePlatformStaff(JOBS_SYSTEM_READ_ROLE);
    return principal.role;
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return null;
    throw err;
  }
}
