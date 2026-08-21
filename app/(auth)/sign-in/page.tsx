import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';
import { SignInCard } from './_components/SignInCard';

// The signed-in landing (MOTIR-2654 · `docs/decisions/home-scope.md` §2.3). The
// literal is duplicated from the client card on purpose for now — MOTIR-3373
// gives the concept one owner and retires both copies together.
const POST_AUTH_LANDING = '/home';

/**
 * `/sign-in` — a SERVER SHELL over the client card (MOTIR-3372).
 *
 * The card itself is unchanged; what is new is that something now asks WHO IS
 * ASKING before rendering it. A reader with a valid session has nothing to
 * authenticate, so they are sent where they were already going instead of being
 * shown a login form for the account they are in.
 *
 * The pattern is `/device`'s, three directories over: a server page that resolves
 * the session and then renders an interactive island. That page is also the
 * reason the gate is HERE and not one level up — `/device` lives in this route
 * group precisely because it must render FOR a signed-in reader, and
 * `/reset-password` must render for either, so a bounce in
 * `app/(auth)/layout.tsx` would break both.
 *
 * ⚠️ AND NOT IN `proxy.ts`, WHICH LOOKS CHEAPER AND IS A REDIRECT LOOP. Its
 * check is `getSessionCookie` — optimistic cookie PRESENCE, no validation. A
 * reader whose session has expired still carries the cookie, so the proxy would
 * send them `/sign-in` → `/home`, `app/(authed)/layout.tsx` would resolve the
 * session for real, get `null`, and send them back to `/sign-in`. Only an
 * authoritative `getSession()` can decide this, which means it has to be decided
 * in a server component, which is what this file is.
 *
 * Destination precedence, matching what the card computes for the post-auth
 * navigation:
 *
 *   1. `?next=` when it is a safe same-origin path — this is what makes the CLI
 *      hand-off free (`/sign-in?next=%2Fdevice%3Fuser_code%3D…` lands a
 *      signed-in reader straight on the approval screen, code intact) and what
 *      every bounced deep link relies on. `sanitizeNextPath` is what keeps it
 *      from being an open redirect.
 *   2. `/home` otherwise.
 *
 * ⚠️ ONE ARRIVAL STILL RENDERS FOR A SIGNED-IN READER: `?draft=`. The
 * cross-origin idea hand-off (MOTIR-1458) is claimed by a client POST whose
 * whole purpose is the `motir_pending_idea` cookie it plants, and a Server
 * Component may not set a cookie during render — so bouncing first would
 * silently drop the idea somebody typed on motir.co. The card claims it and then
 * navigates on to `/onboarding` itself; see its `sessionActive` prop.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; draft?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = await getSession();
  const hasDraft =
    typeof (Array.isArray(params.draft) ? params.draft[0] : params.draft) === 'string';

  if (session && !hasDraft) {
    redirect(sanitizeNextPath(params.next) ?? POST_AUTH_LANDING);
  }

  return <SignInCard sessionActive={Boolean(session)} />;
}
