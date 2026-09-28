import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  visitorConsentNext,
  visitorGoBackHref,
  visitorSignInPath,
} from '@/lib/visitor/consentPath';
import { VisitorConsentCard } from './_components/VisitorConsentCard';

/**
 * THE VISITOR'S ONE-TIME CONSENT SCREEN (Story MOTIR-6170 · MOTIR-6669; design
 * MOTIR-6641 panel 2, `docs/decisions/visitor-sign-in-and-records.md`).
 *
 * Before a signed-in person who cannot enter a public project reads its live
 * views for the first time, they are told that their name and email will be
 * visible to the project's workspace Managers — and asked. Continue records the
 * consent and goes on to the view they asked for; Go back records nothing.
 *
 * ⚠️ IT WEARS THE `(auth)` FRAME, NOT THE VISITOR SHELL, for the re-consent
 * interstitial's reason (`app/(auth)/re-consent/page.tsx`): a hold drawn inside
 * the shell is a shell whose data was loaded, and nothing of the project may load
 * before the person has agreed. It is also OUTSIDE the Visitor layout (MOTIR-6648)
 * by construction — a different route group — so that layout can send a reader
 * here without redirecting into itself.
 *
 * ⚠️ THE PAGE RE-DERIVES ITS OWN VERDICT through `resolveVisitor`, the one
 * resolution, in its order — not-found FIRST, so a stranger who is signed out
 * learns nothing about a private project; then sign in; then a member, who is
 * sent on and never asked; then the consent itself. Nothing about the reader's
 * standing travels in the URL. There is no `loading.tsx` or `not-found.tsx` under
 * this route: `notFound()` must keep its 404 status (CLAUDE.md).
 */
export default async function VisitorConsentPage({
  params,
  searchParams,
}: {
  params: Promise<{ identifier: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identifier: raw } = await params;
  const identifier = decodeURIComponent(raw);
  const query = await searchParams;

  const session = await getSession();
  const verdict = await projectAccessService.resolveVisitor(identifier, session);

  if (verdict.kind === 'not_found') notFound();
  if (verdict.kind === 'sign_in') {
    redirect(
      visitorSignInPath(verdict.identifier, visitorConsentNext(verdict.identifier, query['next'])),
    );
  }
  // A member never consents. The view they asked for sends them on into their own
  // view of it (the Visitor layout's member redirect, MOTIR-6648).
  if (verdict.kind === 'enter') {
    redirect(visitorConsentNext(verdict.project.identifier, query['next']));
  }
  // Already agreed — in another tab, or a second visit to a bookmarked consent
  // URL. Never ask twice.
  if (verdict.kind === 'visitor') {
    redirect(visitorConsentNext(verdict.ctx.project.identifier, query['next']));
  }

  const { subject } = verdict;
  const requestHeaders = await headers();
  const goBackHref = visitorGoBackHref({
    identifier: subject.identifier,
    referer: requestHeaders.get('referer'),
    publicOrigin: publicSiteOrigin(),
    appOrigin: resolveBaseUrlTrimmed(),
  });

  return (
    <VisitorConsentCard
      identifier={subject.identifier}
      projectName={subject.projectName}
      workspaceName={subject.workspaceName}
      reader={{ name: session?.user.name ?? null, email: session?.user.email ?? '' }}
      destination={visitorConsentNext(subject.identifier, query['next'])}
      goBackHref={goBackHref}
    />
  );
}
