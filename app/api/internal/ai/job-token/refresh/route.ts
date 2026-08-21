import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest, JOB_TOKEN_HEADER } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { inspectJobToken, refreshJobToken } from '@/lib/ai/jobToken';

// POST /api/internal/ai/job-token/refresh  (MOTIR-3288)
//
// Exchange a still-valid job token for a fresh one carrying the SAME identity
// and a new window. The renewal half of the fix; the lease equivalent is
// MOTIR-3221's `renewLease`, and the reasoning is identical — a credential
// whose lifetime is fixed at submit cannot cover work of unknown duration.
//
// WHY THIS EXISTS RATHER THAN A LONGER TTL. The 15-minute window is the blast
// radius of a leaked token, and lengthening it spends exactly the property the
// short TTL was bought for. Renewal keeps the window short while letting the
// WORK be long: a token is only ever valid for fifteen more minutes, but a job
// that is still running can keep saying so.
//
// ⚠️ WHAT THIS DOES NOT DO, and must not:
//
//   * It does NOT revive an EXPIRED token. `authenticateAndLimitJobRequest`
//     refuses one before this handler runs, so a token that has lapsed is dead
//     and the job it belonged to has to fail. That is deliberate: a refresh
//     that accepted expired input would make the TTL unbounded in practice and
//     turn a leaked token into a permanent one. The holder's obligation is to
//     renew BEFORE expiry, exactly as the lease does.
//   * It does NOT widen scope. The new token's claims are re-derived from the
//     presented token — same user, same workspace, same project. There is no
//     request body, so there is nothing for a caller to ask for.
//
// SECURITY, stated plainly because this endpoint mints a credential: it needs
// BOTH the §4a service bearer AND a live §4b job token. A token leaked on its
// own cannot be refreshed. An attacker holding CORE_CALLBACK_SECRET can refresh
// — but that secret IS motir-ai's identity, and anyone holding it can already
// act as the service; this adds no reach they did not have.
//
// Typed errors → status:
//   JobAuthError (missing/forged/EXPIRED token, bad bearer) → 401
//   JobRateLimitedError                                     → 429
export async function POST(req: Request): Promise<Response> {
  try {
    // Authenticate first: this both refuses an expired token and puts the
    // refresh under the same shared AI rate limit as every other read-back, so
    // a renewal loop gone wrong cannot mint without bound.
    await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const mapped = mapJobRequestError(err);
    if (mapped) return mapped;
    throw err;
  }

  // Re-inspect to recover the claims. `authenticateAndLimitJobRequest` returns
  // the acting context rather than the raw claims, and re-deriving them here
  // keeps the mint honest: the new token is a function of the presented one,
  // not of anything this handler chose.
  const verdict = inspectJobToken(req.headers.get(JOB_TOKEN_HEADER) ?? '');
  if (!verdict.ok) {
    // Unreachable in practice — authentication above already passed on this
    // same header. Handled rather than asserted because a 500 here would look
    // like a core fault during exactly the long job this endpoint exists to
    // rescue.
    return NextResponse.json(
      { code: 'token_invalid', error: 'The job token could not be re-read for refresh.' },
      { status: 401 },
    );
  }

  const token = refreshJobToken(verdict.claims);
  const refreshed = inspectJobToken(token);
  /* v8 ignore next 6 -- a token minted one line above cannot fail its own
     verification; the branch exists so `exp` is read from the token rather than
     recomputed here, which is what makes the response's expiry the SAME fact
     the verifier will enforce. */
  if (!refreshed.ok) {
    return NextResponse.json(
      { code: 'token_invalid', error: 'The refreshed token failed verification.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ token, exp: refreshed.claims.exp });
}
