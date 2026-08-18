import 'server-only';

import { cache } from 'react';
import { type PlatformRole } from '@/generated/prisma/client';
import { getSession } from '@/lib/auth';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { NotPlatformStaffError } from './errors';

/**
 * The platform-staff gate — `docs/decisions/platform-staff-auth.md` §2.
 *
 * The ONE thing that grants the `/admin` area and every platform-scoped service
 * method. It answers a question no other guard in motir-core asks: not "does
 * this principal belong to this tenant?" but "is this principal US?".
 *
 * ⚠️ SERVER-SIDE ONLY, structurally. The `server-only` import above makes an
 * accidental client import a BUILD error rather than a review finding, and
 * nothing here reads a header, a cookie claim, a search param or a client prop
 * — the only input is `getSession()` plus a fresh database read. There is no
 * client-trusted path to platform standing, and there is deliberately no way to
 * add one without deleting that import.
 *
 * ⚠️ It lives in `lib/platform/`, NOT in `lib/auth/`. The card that ordered
 * this work said `lib/auth/`; the ADR that outranks it (its own `blocked_by`,
 * merged 2026-08-17 after the card was authored) places it here, because
 * `lib/auth/index.ts` is Better-Auth's adapter wiring — a framework boundary
 * `CLAUDE.md` names as not-to-refactor — and `lib/permissions/` is the TENANT
 * vocabulary this is separate from (§1). The card was amended on the record.
 */

/** The acting platform principal — what a gated surface is handed. */
export interface PlatformPrincipal {
  userId: string;
  email: string;
  role: PlatformRole;
}

/**
 * The ladder, low to high. `support` ⊂ `operator` ⊂ `superadmin` (ADR §1) —
 * each degree CONTAINS the one before it, so `minimum` is an index comparison
 * and not a set membership test.
 *
 * Exported so a consumer can assert the ordering rather than re-encoding it;
 * `tests/platform/platformStaffGate.test.ts` pins that this array and the Prisma
 * enum stay the same set, so adding a fourth degree without placing it on the
 * ladder fails a test instead of silently sorting as -1.
 */
export const PLATFORM_ROLE_LADDER = [
  'support',
  'operator',
  'superadmin',
] as const satisfies readonly PlatformRole[];

/** True when `role` is at or above `minimum` on the ladder. */
export function platformRoleAtLeast(role: PlatformRole, minimum: PlatformRole): boolean {
  return PLATFORM_ROLE_LADDER.indexOf(role) >= PLATFORM_ROLE_LADDER.indexOf(minimum);
}

/**
 * Resolve the acting platform principal, or throw `NotPlatformStaffError`.
 *
 * @param minimum the lowest degree that satisfies this call site. A read
 *   surface asks for `support` (the default); MOTIR-1167's two day-1 writes ask
 *   for `operator`; Story 10.3's governance asks for `superadmin`.
 *
 * @throws NotPlatformStaffError for an anonymous request, a signed-in tenant
 *   user (INCLUDING a workspace owner and an org owner — no tenant role at any
 *   tier produces platform standing), and a staff user below `minimum`. The
 *   three are indistinguishable by design; see `NotPlatformStaffError`.
 *
 * Wrapped in React `cache()` so a layout and the page beneath it resolve one
 * principal per request — the shape `getSession` itself uses. The cache is
 * per-REQUEST, so it never outlives a revocation.
 */
export const requirePlatformStaff = cache(async function requirePlatformStaff(
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal> {
  const session = await getSession();
  if (!session) throw new NotPlatformStaffError();

  const standing = await platformStaffRepository.findStandingByUserId(session.user.id);
  if (!standing?.platformRole) throw new NotPlatformStaffError();
  if (!platformRoleAtLeast(standing.platformRole, minimum)) throw new NotPlatformStaffError();

  return { userId: standing.id, email: standing.email, role: standing.platformRole };
});
