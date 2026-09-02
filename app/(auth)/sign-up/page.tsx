import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { resolvePostAuthDestination } from '@/lib/navigation/landing';
import { SignUpCard } from './_components/SignUpCard';
import { signUpLegalLinks } from '@/lib/legal/links';

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
    redirect(resolvePostAuthDestination({ next: params.next }));
  }

  // The legal notice links the CONFIGURED manifest's absolute urls, and renders
  // nothing at all when the deployment has published none (MOTIR-4010). Resolved
  // here because the manifest is a server-side read and the card is a client
  // component — which also keeps the operator's document list out of the bundle.
  return <SignUpCard legal={signUpLegalLinks()} />;
}
