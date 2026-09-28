import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import { projectsService } from '@/lib/services/projectsService';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces';
import { visitorConsentNext } from '@/lib/visitor/consentPath';
import { VISITOR_COOKIE, visitorCookieOptions } from '@/lib/visitor/cookie';
import { memberPathForVisitorPath } from '@/lib/visitor/routes';

/**
 * `/p/<identifier>/enter?next=<Visitor view>` — a MEMBER opened a Visitor link
 * (Story MOTIR-6170 · MOTIR-6648). The Visitor layout sends a reader who can
 * ENTER the project here, because a layout cannot set a cookie: this makes the
 * project their active one (`projectsService.enterFromVisitorLink`, the shipped
 * switch), pins its workspace with the switcher's own cookie, forgets the
 * Visitor cookie, and redirects to the same view in their own app — `board` →
 * `/boards`, `tree` → `/items?view=tree`, `items/<key>` → `/items/<key>`, and so
 * on (`lib/visitor/routes.ts`).
 *
 * It re-derives the verdict rather than trusting the layout that sent the reader:
 * anyone who is not an entrant goes back to the Visitor view, where the layout
 * decides again (not-found, sign in, consent, or the view). `next` is validated to
 * a Visitor view of THIS project, so the redirect can go nowhere else.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ identifier: string }> },
): Promise<Response> {
  const { identifier: raw } = await params;
  const identifier = decodeURIComponent(raw);
  const next = visitorConsentNext(identifier, new URL(req.url).searchParams.get('next') ?? '');
  const origin = resolveBaseUrlTrimmed();

  const session = await getSession();
  const entered = session
    ? await projectsService.enterFromVisitorLink(identifier, session.user.id)
    : null;
  if (!entered) return NextResponse.redirect(`${origin}${next}`);

  const response = NextResponse.redirect(`${origin}${memberPathForVisitorPath(next) ?? '/'}`);
  // The switcher's own cookie options (`app/(authed)/_actions.ts`).
  response.cookies.set(WORKSPACE_COOKIE_NAME, entered.workspaceId, {
    httpOnly: false,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/',
  });
  response.cookies.set(VISITOR_COOKIE, '', { ...visitorCookieOptions(), maxAge: 0 });
  return response;
}
