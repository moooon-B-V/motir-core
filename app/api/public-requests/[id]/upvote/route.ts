import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { enforcePublicWriteRateLimit } from '@/lib/rateLimit/publicWriteGuard';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// POST /api/public-requests/[id]/upvote (Story 6.12 · Subtask 6.12.6) — toggle
// the signed-in account's upvote on a public request. Sign-in-to-act: the route
// requires a session but NOT workspace membership (the vote is cross-org —
// `getSession`, not `getWorkspaceContext`); the service enforces the public
// project + the `canUpvotePublicRequest` grant. Thin HTTP layer (CLAUDE.md).
//
//   POST → 200 { voted: boolean, voteCount: number }
//
// Typed errors → status codes (404-not-403 posture for a non-public / missing
// request — no existence leak):
//   PublicRequestNotFoundError / ProjectNotFoundError        → 404
//   ProjectAccessDeniedError                                 → 403

//
// ── ⚠️ WHY THIS ROUTE STAYS OUTSIDE `app/api/public/*` (MOTIR-4114) ────────
//
// It sits in a namespace that predates the public CONTRACT, so
// `tests/api/public/contract-coverage.test.ts` cannot see it, and until this
// card `cloud-gate-totality` did not gate it either — a self-hosted build
// answered an endpoint belonging to a feature it is not supposed to have.
// Nobody planned that; it is where the namespace happened to fall.
//
// `public-surface-hosts.md` AMENDMENT 3 §F DECIDES it, and the decision is to
// leave it here with the reason written down: after AMENDMENT 3 nothing on
// `motir.co` calls this route. Vote and comment are HAND-OFFS (rows 4 and 5) —
// the visitor comes to THIS origin and acts under this application's own
// session — so this is an application route serving the application's own act
// surface, not an entry in the public read contract. Declaring it there would
// document an operation no consumer of that document can invoke: the session
// cookie is `sameSite: \'lax\'`, so a cross-origin credentialed call is
// impossible whatever the contract said.
//
// What WAS a real hole is closed below: the capability gate. Public projects are
// a CLOUD capability (§5), and this route acts on one.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // The CAPABILITY gate (MOTIR-4034 / MOTIR-4114) — FIRST, before the rate
  // limit and before any session read, exactly as every `app/api/public/*`
  // route does it: with `MOTIR_CLOUD` unset there are no public projects, so
  // there is no public request to vote on or comment under.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  // The shared per-IP public-write ceiling (8.5.9 / MOTIR-1165), before the
  // session read — see `lib/rateLimit/publicWriteGuard.ts`.
  const limited = await enforcePublicWriteRateLimit(req);
  if (limited) return limited;

  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { id } = await params;
  try {
    const result = await publicRequestsService.toggleUpvote(id, { userId: session.user.id });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PublicRequestNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
    }
    throw err;
  }
}
