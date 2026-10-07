import 'server-only';

import type { PlatformRole } from '@/generated/prisma/client';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import type { IdeaActor } from '@/lib/ideas/types';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import { platformStaffRepository } from '@/lib/repositories/platformStaffRepository';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { platformRoleAtLeast, requirePlatformStaff } from './auth';
import { NotPlatformStaffError } from './errors';

/**
 * The IDEAS gate — the one door where a platform-staff member's personal access
 * token stands in for their console session (Story MOTIR-7662 · MOTIR-7673;
 * `docs/decisions/platform-staff-auth.md` §2, the 2026-10-07 amendment).
 *
 * ⚠️ IMPORTABLE FROM `app/api/platform/ideas/**` ONLY.
 * `tests/platform/platformTokenBoundary.test.ts` fails the build when any other
 * file under `app/` or `lib/` imports this module. That is what keeps the
 * exception one door wide: it is a SEPARATE gate, not a flag on
 * `requirePlatformStaff`, so no other platform surface is ever one argument away
 * from accepting a token.
 *
 * Admits exactly two principals:
 *  - a request with NO bearer header → `requirePlatformStaff(minimum)`, the
 *    console session exactly as every other platform surface reads it;
 *  - a request carrying `Authorization: Bearer motir_pat_…` → the token's OWNER,
 *    when the token is not a run token and the owner's CURRENT platform role
 *    (read fresh, so a demotion bites on the next call) is at or above
 *    `minimum`. No grant is consulted — the amendment's "no new scope".
 *
 * Every refusal — anonymous, non-staff, below the level, unknown / revoked /
 * expired token, a suspended org's token, a run token — is the same
 * `NotPlatformStaffError`, which the routes answer with the same 404.
 *
 * A bearer header that does not carry a `motir_pat_` token is REFUSED, never
 * quietly downgraded to the session path: a caller who sent a credential gets
 * an answer about that credential.
 */
export async function requirePlatformStaffForIdeas(
  req: Request,
  minimum: PlatformRole,
): Promise<IdeaActor> {
  const bearer = bearerFromHeader(req.headers.get('authorization'));
  if (bearer === undefined) {
    const principal = await requirePlatformStaff(minimum);
    return { ...principal, credential: { kind: 'session' } };
  }
  if (!bearer.startsWith(TOKEN_PREFIX)) throw new NotPlatformStaffError();

  let verified: Awaited<ReturnType<typeof apiTokensService.verify>>;
  try {
    verified = await apiTokensService.verify(bearer);
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError ||
      err instanceof OrganizationSuspendedError
    ) {
      throw new NotPlatformStaffError();
    }
    throw err;
  }
  if (verified.dispatchRunId !== null) throw new NotPlatformStaffError();

  const standing = await platformStaffRepository.findStandingByUserId(verified.user.id);
  if (!standing?.platformRole) throw new NotPlatformStaffError();
  if (!platformRoleAtLeast(standing.platformRole, minimum)) throw new NotPlatformStaffError();

  return {
    userId: standing.id,
    email: standing.email,
    role: standing.platformRole,
    credential: { kind: 'token', apiTokenId: verified.tokenId },
  };
}

/** The `Bearer` credential, or undefined when the header is absent or another scheme. */
function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}
