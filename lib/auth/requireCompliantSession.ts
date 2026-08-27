import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { TWO_FACTOR_REQUIRED_PATH } from '@/lib/auth/twoFactorGate';
import { twoFactorPolicyService } from '@/lib/services/twoFactorPolicyService';
import { getWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces';

// The API half of 2FA enforcement (Story MOTIR-1215 · Subtask MOTIR-3653).
//
// MOTIR-3648 holds a non-compliant person out of every PAGE, in the route
// groups' layouts. This holds them out of the cookie-authenticated API — the
// other half of "blocked from scoped resources", and the half a layout gate
// structurally cannot reach: a member stopped at the enrolment screen still
// holds a valid session cookie and could otherwise drive the whole product
// through `fetch('/api/…')` from a browser console.
//
// ⚠️ A REFUSAL, NOT A REDIRECT. An API caller has nowhere to be redirected to,
// and a 302 to an HTML page is the worst possible answer to a `fetch` — it
// either follows into HTML the caller cannot parse or reports a CORS-ish
// mystery. So the answer is a 403 with a typed body naming the mandating tier
// and where to go, which a client can tell apart from an ordinary authorization
// failure.
//
// ⚠️ ONE VERDICT, SHARED. It calls the same `resolveRequirement` the page gate
// calls — there is no second implementation of the predicate, and
// `hasSecondFactor` remains its single definition one layer down. The read is
// request-memoised through `getSession`'s own `cache()` boundary only for the
// session; the policy read is one query (`twoFactorPolicyRepository.findRequirement`),
// which is why this costs a request one round trip and not four.

/** The session shape `getSession()` resolves to, with the null stripped. */
export type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/**
 * The typed refusal body. `code` is what a client branches on.
 *
 * `TWO_FACTOR_REQUIRED` is deliberately distinct from `UNAUTHENTICATED` (no
 * session at all) and from `FORBIDDEN` (a session that may not do this): the
 * remedy differs in each case, and a client that cannot tell them apart cannot
 * tell the person what to do next.
 */
export interface TwoFactorRequiredBody {
  code: 'TWO_FACTOR_REQUIRED';
  /** `organization` or `workspace` — which tier is asking. */
  tier: 'organization' | 'workspace';
  /** Its name, so a client can say who is asking without a second call. */
  tierName: string;
  /** Where a browser client should send the person to satisfy it. */
  enrolAt: string;
}

export type CompliantSessionResult =
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; response: NextResponse };

/**
 * Read the session AND the 2FA requirement, refusing when either fails.
 *
 * Replaces the two-line preamble every cookie-authenticated route carried:
 *
 * ```ts
 * const session = await getSession();
 * if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
 * ```
 *
 * with
 *
 * ```ts
 * const gate = await requireCompliantSession();
 * if (!gate.ok) return gate.response;
 * const { session } = gate;
 * ```
 *
 * — so `session` stays in scope under the same name and nothing below the
 * preamble changes. That uniformity is what made the sweep mechanical, and
 * `tests/api/two-factor-api-gate.test.ts` is what keeps route 87 from
 * reopening the hole.
 *
 * ⚠️ 401 STILL COMES FIRST. No session is not a 2FA problem, and answering it
 * with a 403 would tell an anonymous caller to go and enrol.
 */
export async function requireCompliantSession(): Promise<CompliantSessionResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    };
  }

  const hold = await resolveTwoFactorHold(session.user.id);
  if (!hold) return { ok: true, session };
  return { ok: false, response: NextResponse.json(hold, { status: 403 }) };
}

/**
 * THE ONE VERDICT, in its rawest form: the hold this person is under, or `null`
 * when nobody is holding them.
 *
 * `requireCompliantSession` is the shape 84 of the 86 cookie-authenticated
 * routes want. Two want the same verdict in a different wrapper, because their
 * no-session arm is not a 401 and must stay as it is:
 *
 *   · `app/api/ai/access` answers an anonymous caller with the inert
 *     `NOT_APPLICABLE` sentinel — its contract is *never error, always answer* —
 *     and turning that into a 401 would be a behaviour change this card is not
 *     making. It refuses a HELD caller with the ordinary 403.
 *   · `app/api/github/setup` is a browser NAVIGATION endpoint, not a `fetch`:
 *     GitHub sends the person here in the address bar. It redirects a signed-out
 *     visitor to `/sign-in` with a return target, and a HELD one to the
 *     enrolment screen with the same return target — a 403 JSON body would be
 *     rendered as text in the address bar, and dropping the return target would
 *     lose the installation.
 *
 * ⚠️ THEY SHAPE THE ANSWER; THEY DO NOT RE-DECIDE IT. Both go through this
 * function, so `resolveRequirement` stays the single predicate and
 * `tests/api/two-factor-api-gate.test.ts` can assert there is exactly one.
 */
export async function resolveTwoFactorHold(userId: string): Promise<TwoFactorRequiredBody | null> {
  const requirement = await twoFactorPolicyService.resolveRequirement(userId);
  if (!requirement.required || requirement.compliant) return null;

  return {
    code: 'TWO_FACTOR_REQUIRED',
    tier: requirement.mandatedBy!.tier,
    tierName: requirement.mandatedBy!.name,
    enrolAt: TWO_FACTOR_REQUIRED_PATH,
  };
}

/**
 * The compliance half alone as a 403 — for a route that keeps its own
 * no-session arm but wants the ordinary refusal for a held caller.
 *
 * Returns the response to return, or `null` to carry on.
 */
export async function refuseIfNonCompliant(userId: string): Promise<NextResponse | null> {
  const hold = await resolveTwoFactorHold(userId);
  return hold ? NextResponse.json(hold, { status: 403 }) : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE SECOND DOOR — and the one an enumeration by `getSession` MISSES.
 *
 * `app/api/**` authenticates through TWO helpers, not one:
 *
 *   · `getSession()`               — 86 files, personal/session-scoped routes
 *   · `getWorkspaceContext()`      — 98 files, every tenant-scoped route
 *
 * The second calls `getSession()` INSIDE `lib/workspaces/index.ts` and returns a
 * `{ userId, workspaceId }`, so a route that uses it never names `getSession`
 * anywhere in its own source. Grepping for `getSession` under `app/api` finds 86
 * files and reports the sweep complete — while 98 files holding the whole of
 * work items, projects, plans, sprints, reports, dashboards, notifications and
 * triage are still open to a held member. That is the larger half of the API.
 *
 * So the gate is applied at BOTH doors, and the guard test enumerates both.
 * ─────────────────────────────────────────────────────────────────────────── */

export type CompliantWorkspaceContextResult =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; response: NextResponse };

/**
 * `getWorkspaceContext()` plus the 2FA hold — the tenant-scoped twin of
 * `requireCompliantSession`.
 *
 * Replaces the preamble 98 route files carried:
 *
 * ```ts
 * const ctx = await getWorkspaceContext();
 * if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
 * ```
 *
 * with
 *
 * ```ts
 * const gate = await requireCompliantWorkspaceContext();
 * if (!gate.ok) return gate.response;
 * const { ctx } = gate;
 * ```
 *
 * — `ctx` stays in scope under the same name, so nothing below the preamble
 * changed in any of the 98.
 *
 * ⚠️ 401 STILL COMES FIRST, and it keeps its own meaning: `getWorkspaceContext`
 * returns `null` for no session AND (in principle) for an unresolvable
 * workspace, and both were already answered 401 here. This does not touch that
 * arm — it adds the hold BELOW it.
 *
 * ⚠️ NO SECOND SESSION READ. `getWorkspaceContext` calls `getSession` through
 * the request-memoised accessor (MOTIR-2453), and the userId it hands back is
 * the same one, so the hold is resolved from `ctx.userId` rather than by reading
 * the session again. One policy query, no extra auth round trip.
 */
export async function requireCompliantWorkspaceContext(): Promise<CompliantWorkspaceContextResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return {
      ok: false,
      response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    };
  }

  const hold = await resolveTwoFactorHold(ctx.userId);
  if (!hold) return { ok: true, ctx };
  return { ok: false, response: NextResponse.json(hold, { status: 403 }) };
}
