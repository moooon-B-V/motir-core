import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectPath } from '@/lib/publicProjects/urls';
import { resolveHandoffDestination } from '@/lib/publicProjects/returnTarget';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// THE HAND-OFF ENTRY (MOTIR-4114 · `public-surface-hosts.md` AMENDMENT 3 §D/§F).
//
// ── What arrives here, and why it is a LINK rather than a fetch ────────────
//
// AMENDMENT 3 routes follow, roadmap vote, request upvote, request comment and
// the request intake as a HAND-OFF. The control on `motir.co` is an `<a href>`
// to this route; the visitor is signed in here if they are not already, the act
// happens on this origin under this application's own session and CSRF posture,
// and they are returned to the page they left.
//
// It is a link and not a cross-origin `fetch` because a cross-origin `fetch`
// CANNOT WORK, and that is a mechanical fact rather than a preference:
// `lib/auth/index.ts` sets the session cookie `sameSite: 'lax'`, so no
// credential is attached to a cross-site request at all. Making one work would
// mean `sameSite: 'none'` — a widening §4 rejects, and the reason AMENDMENT 3 §B
// says the binding constraint is `SameSite` rather than the `Domain` everybody
// names. Nothing here reads or needs a cookie from `motir.co`.
//
// ── ⚠️ WHAT THIS ROUTE DOES *NOT* DO: PERFORM THE ACT ─────────────────────
//
// It is a GET, and a GET does not mutate. Following, voting and commenting are
// writes, and a link that wrote would be a CSRF primitive: any page anywhere
// could `<img src="https://app.motir.co/act?intent=follow&…">` and act as
// whoever loaded it. So this route RESOLVES and REDIRECTS — it decides where in
// the application the visitor performs the act, carries the validated return
// destination along, and stops there. The surface that performs it is
// MOTIR-4119's on the public side and the application's own project surfaces on
// this one; the pixels of the hand-off are MOTIR-4113's (AMENDMENT 3 §I).
//
// ── The return destination is ALLOW-LISTED, never reflected ───────────────
//
// `resolveHandoffDestination` admits a URL only when its ORIGIN equals
// `publicSiteOrigin()`, and answers a fixed safe path otherwise. `proxy.ts`'s
// `CURRENT_PATH_HEADER` doc names this hazard in terms: an unvalidated redirect
// target taken from a request is "the one way this small piece of plumbing could
// ship a vulnerability". That module carries the reasoning and the cases.
//
// ── Posture ───────────────────────────────────────────────────────────────
//
// CLOUD-GATED: this route exists only where public projects do (§5). SESSION
// REQUIRED, and a missing session is a REDIRECT to sign-in rather than a 401 —
// the caller is a person following a link, not a script, and 401 to a browser
// navigation is a blank page. `?next=` back to this same URL, so signing in
// resumes the hand-off rather than dropping the visitor on a dashboard.

/** The intents the public site may hand off, and where each is performed. */
const INTENTS = ['follow', 'vote', 'upvote', 'comment', 'request'] as const;
type Intent = (typeof INTENTS)[number];

function isIntent(value: string | null): value is Intent {
  return value !== null && (INTENTS as readonly string[]).includes(value);
}

/**
 * Where in the application an intent is performed.
 *
 * Every one of them lands on the project's own public page ON THIS ORIGIN,
 * because that is the surface that already holds the affordance and already has
 * the session. Until the cutover configures `MOTIR_PUBLIC_SITE_URL` that is
 * literally the same page the visitor came from, which is harmless: the
 * hand-off is a no-op in the pre-cutover world and becomes a real hop when the
 * origins split. The `intent` and `return` are carried so the destination can
 * open the right affordance and send the visitor back.
 */
function destinationFor(intent: Intent, subject: string, returnTo: string): string {
  const url = new URL(publicProjectPath(subject), 'https://placeholder.invalid');
  url.searchParams.set('act', intent);
  url.searchParams.set('return', returnTo);
  return `${url.pathname}${url.search}`;
}

export async function GET(req: Request) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before any session read: with
  // `MOTIR_CLOUD` unset there are no public projects and nothing to hand off.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const url = new URL(req.url);
  const intent = url.searchParams.get('intent');
  const subject = url.searchParams.get('subject');

  // The destination is resolved BEFORE the session check, so that the sign-in
  // round trip cannot lose it and so that a hostile value is refused whether or
  // not the visitor happens to be signed in.
  const returnTo = resolveHandoffDestination(url.searchParams.get('return') ?? undefined);

  if (!isIntent(intent) || subject === null || subject.length === 0) {
    // A malformed hand-off is a person with a broken link, not an API client:
    // send them somewhere real rather than showing them a JSON error body.
    return NextResponse.redirect(new URL(returnTo, req.url), 303);
  }

  const session = await getSession();
  if (!session) {
    const signIn = new URL('/sign-in', req.url);
    // Back to THIS url — intent, subject and the (already validated) return —
    // so signing in resumes the hand-off instead of ending it.
    const resume = new URL('/act', req.url);
    resume.searchParams.set('intent', intent);
    resume.searchParams.set('subject', subject);
    resume.searchParams.set('return', returnTo);
    signIn.searchParams.set('next', `${resume.pathname}${resume.search}`);
    return NextResponse.redirect(signIn, 303);
  }

  return NextResponse.redirect(new URL(destinationFor(intent, subject, returnTo), req.url), 303);
}
