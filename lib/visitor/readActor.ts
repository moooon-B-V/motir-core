import { headers } from 'next/headers';
import type { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { enforcePublicReadRateLimit } from '@/lib/rateLimit/publicReadGuard';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { VISITOR_ADDRESS_HEADER, isVisitorAddressValue } from '@/lib/visitor/address';

// THE ONE ENTRANCE a Visitor's data doors use (Story MOTIR-6170 · MOTIR-6647;
// `docs/decisions/visitor-sign-in-and-records.md`).
//
// A Visitor page renders server-side and then keeps fetching — tree levels, the
// board, the peek, activity, the run modal — from `app/api/**` routes that serve
// a member of the project's own workspace. The Visitor tab names the public
// project it reads on EVERY request, as the `x-motir-visitor` header
// (`lib/visitor/address.ts`, MOTIR-6892), and a GET route asks THIS module whether
// that reader is its Visitor.
//
// ⚠️ THE HEADER, NOT THE COOKIE. The `motir_visitor` cookie `proxy.ts` sets on a
// Visitor view used to be the address, and a cookie is one value per BROWSER: the
// reader's own member page in ANOTHER tab clears it, and the Visitor tab's next
// read was answered from the reader's own project — while a stale cookie served
// the public project's board inside a member tab. The cookie is now only the
// proxy's redirect hint; no data door reads it.
//
// ⚠️ THE ADDRESS IS AN ADDRESS, NEVER A CREDENTIAL. It grants nothing on its own:
// a Visitor is served only when the request's SESSION resolves, through
// `resolveVisitor`, to a `visitor` verdict for the project the address names —
// signed in, unable to enter it, and holding a visitor record. `sign_in`,
// `consent`, `enter` and `not_found` all fall back to exactly what the route
// answers today; a data door never serves the consent screen (the page layout
// does). No session ⇒ the address is never resolved.
//
// ⚠️ ONLY GET HANDLERS CALL THIS. A POST / PATCH / PUT / DELETE is decided exactly
// as it always was, so a Visitor stays refused on every write door (proven over
// all of them by MOTIR-6650).

/**
 * The public identifier this request's Visitor address names (the
 * `x-motir-visitor` header a Visitor tab sends — MOTIR-6892), or null. The ONLY
 * address the data doors read: a request without it is a member's.
 */
export function readVisitorAddress(req: Request): string | null {
  const value = req.headers.get(VISITOR_ADDRESS_HEADER)?.trim();
  if (!value) return null;
  return isVisitorAddressValue(value) ? value : null;
}

/** What {@link resolveReadActor} answers. */
export type ReadActor =
  | { kind: 'visitor'; ctx: VisitorReadContext }
  /** The reader is this project's Visitor, and has spent their `public-read` budget. */
  | { kind: 'limited'; response: NextResponse }
  /** Not a Visitor request — the route answers exactly as it does today. */
  | { kind: 'none' };

/**
 * Is this request a Visitor's read? Only when there is a compliant SESSION, a
 * Visitor address, and `resolveVisitor(address, session)` answers `visitor`;
 * then the read spends the reader's `public-read` budget (per user) and a spent
 * budget answers the 429. Everything else is `none`.
 */
export async function resolveReadActor(req: Request): Promise<ReadActor> {
  const identifier = readVisitorAddress(req);
  if (!identifier) return { kind: 'none' };
  // A COMPLIANT session, exactly as the member doors require one: a reader held
  // by the two-factor rule is no more a Visitor than a member.
  const gate = await requireCompliantSession();
  if (!gate.ok) return { kind: 'none' };
  const verdict = await projectAccessService.resolveVisitor(identifier, {
    user: { id: gate.session.user.id },
  });
  if (verdict.kind !== 'visitor') return { kind: 'none' };
  const limited = await enforcePublicReadRateLimit(req, verdict.ctx.actorUserId);
  if (limited) return { kind: 'limited', response: limited };
  return { kind: 'visitor', ctx: verdict.ctx };
}

/**
 * MEMBER FIRST — for a route ADDRESSED by the resource it reads (an item id, a
 * plan id, a run id, a project key). The member read runs exactly as today and,
 * when it serves the reader, is the answer. Only when it answers NOT-FOUND (404),
 * or UNAUTHENTICATED (401) to a reader who is in fact signed in but has no
 * workspace, is the Visitor path tried — and only a Visitor of the project the
 * address names is served; the Visitor read refuses a resource of any other
 * project as not-found (`openVisitorRead`). Otherwise the member's own answer
 * stands, byte for byte.
 */
export async function memberThenVisitor(
  req: Request,
  member: () => Promise<Response>,
  visitor: (ctx: VisitorReadContext) => Promise<Response>,
): Promise<Response> {
  const answer = await member();
  if (answer.status !== 404 && answer.status !== 401) return answer;
  // No address, no Visitor — nothing further is read, so today's answer stands.
  if (!readVisitorAddress(req)) return answer;
  if (answer.status === 401 && !(await getSession())) return answer;
  const actor = await resolveReadActor(req);
  if (actor.kind === 'none') return answer;
  if (actor.kind === 'limited') return actor.response;
  return visitor(actor.ctx);
}

/**
 * VISITOR FIRST — for a route addressed by the reader's ACTIVE project (the board,
 * the boards list, the sprints list, the peek and the approval overlay by key),
 * which names no project of its own. There "member first" would serve a signed-in
 * stranger THEIR OWN active project inside the public project's page, so the
 * address's verdict decides first: a `visitor` verdict is served from the
 * address's project; every other reader — a member of the public project (verdict
 * `enter`) included, and every request carrying no address — is answered exactly
 * as today.
 */
export async function visitorThenMember(
  req: Request,
  member: () => Promise<Response>,
  visitor: (ctx: VisitorReadContext) => Promise<Response>,
): Promise<Response> {
  const actor = await resolveReadActor(req);
  if (actor.kind === 'limited') return actor.response;
  if (actor.kind === 'visitor') return visitor(actor.ctx);
  return member();
}

/**
 * {@link resolveReadActor} for a SERVER ACTION a Visitor view calls to READ (the
 * lazy tree's levels), which has headers but no `Request`. The request is rebuilt
 * from the incoming Visitor address and forwarding headers only — Next posts the
 * action through the tab's `fetch`, which carries the address — and the limiter
 * reads the path solely to exempt its own excluded routes, so a fixed action path
 * is used.
 */
export async function resolveActionReadActor(): Promise<ReadActor> {
  let incoming: Awaited<ReturnType<typeof headers>>;
  try {
    incoming = await headers();
  } catch {
    // Called outside a request scope (a direct invocation): there is no
    // address to read, so no Visitor — the member path answers as today.
    return { kind: 'none' };
  }
  const forwarded: Record<string, string> = {};
  for (const name of [VISITOR_ADDRESS_HEADER, 'x-forwarded-for', 'x-real-ip']) {
    const value = incoming.get(name);
    if (value) forwarded[name] = value;
  }
  return resolveReadActor(
    new Request('http://localhost/actions/visitor-read', { headers: forwarded }),
  );
}
