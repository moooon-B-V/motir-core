import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { resolveTwoFactorHold } from '@/lib/auth/requireCompliantSession';
import { decodeInstallStateResult } from '@/lib/github/installState';
import type { GithubBannerStatus } from '@/lib/github/bannerStatus';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { resolveReturnPath } from '@/lib/github/returnSurface';

// GET /api/github/setup (Story 7.10 · MOTIR-1588) — the GitHub App's **Setup URL**.
// After a user installs the App, GitHub redirects here with `installation_id` +
// `setup_action` (+ the signed `state` the install link carried). This route
// establishes the installation → workspace binding the webhook (MOTIR-892)
// deliberately does NOT create, then bounces to the settings page.
//
// Routes are HTTP-only (CLAUDE.md): read the session, verify the signed state,
// authorize the actor, call ONE service method, redirect. The binding write, the
// account/repo fetch through the provider seam, and the persist all live in
// `githubInstallationService.bindInstallationForWorkspace`.

// WHERE THIS HANDLER RETURNS TO (MOTIR-4676). The install starts from a bare
// github.com URL, so no cookie can carry the origin — it rides INSIDE the signed
// install state, covered by the same HMAC as the workspace and the user, and is
// narrowed back to a known surface id on decode. Every outcome BEFORE the state
// has been read (and every one where it cannot be read) falls back to the
// historical settings path, which is what the handler did for all of them.
function settingsRedirect(status: GithubBannerStatus, origin?: string | null): NextResponse {
  return NextResponse.redirect(
    `${resolveBaseUrlTrimmed()}${resolveReturnPath(origin ?? null)}?github=${status}`,
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) {
    // Preserve the return target so a fresh sign-in lands back on this handler
    // with GitHub's install params intact.
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}/sign-in?next=${next}`);
  }

  // The 2FA hold (MOTIR-3653), shaped as a REDIRECT rather than the 403 the
  // other 85 routes return: GitHub sends the person here in the ADDRESS BAR, so
  // a JSON body would be rendered as text. The return target rides along for the
  // same reason it does above — enrol, come back, and the installation still
  // binds instead of being lost.
  const hold = await resolveTwoFactorHold(session.user.id);
  if (hold) {
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${hold.enrolAt}?next=${next}`);
  }

  const params = req.nextUrl.searchParams;
  const installationId = params.get('installation_id');
  const setupAction = params.get('setup_action');
  const state = params.get('state');

  // `request`/`deny` (org approval) and any non-install action carry nothing to
  // bind — just show the current state rather than erroring.
  if (setupAction && setupAction !== 'install' && setupAction !== 'update') {
    return settingsRedirect('installed');
  }

  // NO STATE AT ALL — the round trip did not START in Motir, so there was never
  // a state to lose and nothing has failed (MOTIR-3755). `encodeInstallState` is
  // called in exactly one place, the settings page's install link, so a request
  // arriving without one came from github.com.
  //
  // The overwhelmingly common case is editing the installation's REPOSITORY
  // SELECTION from the App's own settings on GitHub: it redirects here with
  // `setup_action=update` and no state, and the repository really is connected —
  // the repository set is maintained by the `installation_repositories` webhook,
  // not by this handler, and the installation → workspace binding this route
  // exists to write ALREADY EXISTS. Reporting `install_error` there told the
  // person the opposite of what happened and invited them to re-run an install
  // that had already succeeded.
  //
  // A bare `install` with no state is a DIFFERENT outcome and keeps its own
  // message: the App was installed from GitHub rather than from Motir, so no
  // binding was written and there IS something left to do.
  if (!state) {
    return settingsRedirect(setupAction === 'update' ? 'repos_updated' : 'install_unbound');
  }
  if (!installationId) return settingsRedirect('install_error');

  // The state is present, so it is verified exactly as before — this card
  // changed what a MISSING state means, never what a present one is trusted for.
  const decoded = decodeInstallStateResult(state);
  if (!decoded.ok) {
    // An EXPIRED state is not a failure either: the person started from Motir
    // and spent longer than the 10-minute TTL on GitHub's repository picker. Its
    // remedy (start again from Settings) is the opposite of the tampered case's,
    // so the two must not share a banner.
    return settingsRedirect(decoded.reason === 'expired' ? 'install_expired' : 'install_error');
  }
  // A state minted for a different user — the acting session must be the one
  // that started the install.
  if (decoded.state.userId !== session.user.id) return settingsRedirect('install_error');

  // From here the state has VERIFIED, so its origin is ours and every remaining
  // outcome returns the person to the surface they started from.
  const origin = decoded.state.origin ?? null;

  // Authorize: the acting user must be a member of the target workspace — no
  // cross-workspace binding even with a validly-signed state.
  const role = await workspacesService.getMemberRole(session.user.id, decoded.state.workspaceId);
  if (!role) return settingsRedirect('install_forbidden', origin);

  try {
    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: decoded.state.workspaceId,
      installationId,
    });
  } catch {
    // Provider/config failure (e.g. GITHUB_APP_ID/PRIVATE_KEY unset) — surface a
    // clean banner, never a 500.
    return settingsRedirect('install_provider_error', origin);
  }

  return settingsRedirect('installed', origin);
}
