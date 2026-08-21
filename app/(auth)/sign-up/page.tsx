import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';
import { SignUpCard } from './_components/SignUpCard';

// The signed-in landing (MOTIR-2654 · MOTIR-2921 moved sign-up onto it ·
// `docs/decisions/home-scope.md` §2.3). Duplicated from the client card for now;
// MOTIR-3373 gives the concept one owner and retires both copies together.
const POST_AUTH_LANDING = '/home';

/**
 * `/sign-up` — a SERVER SHELL over the client card (MOTIR-3372), the same shape
 * as `/sign-in` beside it and for the same reason: a reader with a valid session
 * has no account to create, so they are sent on rather than shown a form.
 *
 * Simpler than sign-in in exactly one way — there is no `?draft=` branch here.
 * The cross-origin idea hand-off targets `/sign-in` only (`MOTIR-1458`; the
 * claim POST lives in that card), so nothing on this route needs to render for a
 * signed-in reader.
 *
 * The reasoning about WHERE this gate lives — not `app/(auth)/layout.tsx`, which
 * would break `/device` and the password-reset pages, and not `proxy.ts`, whose
 * optimistic cookie check would loop for an expired session — is written out on
 * `app/(auth)/sign-in/page.tsx` rather than repeated here.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = await getSession();

  if (session) {
    redirect(sanitizeNextPath(params.next) ?? POST_AUTH_LANDING);
  }

  return <SignUpCard />;
}
