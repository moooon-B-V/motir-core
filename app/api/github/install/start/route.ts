import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { resolveTwoFactorHold } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { GITHUB_RETURN_SURFACES, githubReturnLocation } from '@/lib/github/returnSurface';
import {
  onboardingReturnContextFrom,
  onboardingReturnContextParams,
} from '@/lib/planning/onboardingHandoff';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { NotAMemberError } from '@/lib/workspaces/errors';

// GET /api/github/install/start (Story MOTIR-8241 · MOTIR-8471) — the onboarding
// Connect step starts the Motir GitHub App install HERE, and GitHub hands the
// person back to that step (`/api/github/setup` → `/onboarding/migrate`).
//
// It mirrors `app/api/github/oauth/start`: the step's action is a URL, so
// nothing new is threaded through the wizard's props. Routes are HTTP-only
// (CLAUDE.md): read the session and the active workspace, call ONE service
// method, redirect.
//
// The step's own query — the routing outcome, the kept steps and the plan-window
// return address (MOTIR-4770) — is read through `onboardingReturnContextFrom`,
// which keeps only what reads back, and is signed into the install state so it
// comes back unforged. Anything else on the query (`from`, a stray parameter) is
// not carried.
//
// This start serves exactly one surface, the onboarding Connect step; the
// settings surfaces mint their own links.
const ORIGIN = 'onboardingMigrateConnect' as const;

export async function GET(req: NextRequest): Promise<Response> {
  const base = resolveBaseUrlTrimmed();
  const session = await getSession();
  if (!session) {
    // GitHub never saw this request, so the only thing to keep is the step's
    // own query — a fresh sign-in comes straight back here with it intact.
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${base}/sign-in?next=${next}`, 302);
  }

  // The 2FA hold (MOTIR-3653), as a redirect for the same reason the setup
  // handler's is: this request arrives in the ADDRESS BAR.
  const hold = await resolveTwoFactorHold(session.user.id);
  if (hold) {
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${base}${hold.enrolAt}?next=${next}`, 302);
  }

  // The same read the migrate page makes, so onboarding and the page it returns
  // to name one workspace. No active project means the wizard itself would
  // send the person to the entrance — so does this.
  const ctx = await getActiveProject();
  if (!ctx) return NextResponse.redirect(`${base}${ONBOARDING_ENTRY_PATH}`, 302);

  const context = onboardingReturnContextFrom(req.nextUrl.searchParams);
  const backToStep = (status: 'not_configured' | 'install_forbidden') =>
    NextResponse.redirect(
      `${base}${githubReturnLocation(GITHUB_RETURN_SURFACES[ORIGIN], status, {
        context: onboardingReturnContextParams(context),
      })}`,
      302,
    );

  let url: string | null;
  try {
    url = await githubInstallationService.installUrlForOnboardingConnect({
      workspaceId: ctx.workspaceId,
      actorUserId: session.user.id,
      context,
    });
  } catch (err) {
    // The active workspace is one the person belongs to, so this is a race (a
    // membership removed between the two reads) — reported as the callback
    // would report it, never as a 500.
    if (err instanceof NotAMemberError) return backToStep('install_forbidden');
    throw err;
  }
  // No App on this deployment: back to the step, with its own query, told so.
  if (!url) return backToStep('not_configured');
  // 302, not `redirect()`'s default 307: the target is GitHub's install screen,
  // reached by a plain GET.
  return NextResponse.redirect(url, 302);
}
