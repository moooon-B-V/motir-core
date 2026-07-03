import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { decodeInstallState } from '@/lib/github/installState';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

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

const SETTINGS_PATH = '/settings/workspace/github';

function settingsRedirect(status: string): NextResponse {
  return NextResponse.redirect(`${resolveBaseUrlTrimmed()}${SETTINGS_PATH}?github=${status}`);
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session) {
    // Preserve the return target so a fresh sign-in lands back on this handler
    // with GitHub's install params intact.
    const next = encodeURIComponent(`${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(`${resolveBaseUrlTrimmed()}/sign-in?next=${next}`);
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
  if (!installationId || !state) return settingsRedirect('install_error');

  const decoded = decodeInstallState(state);
  // Reject a missing/tampered/expired state, or a state minted for a different
  // user (the acting session must be the one who started the install).
  if (!decoded || decoded.userId !== session.user.id) return settingsRedirect('install_error');

  // Authorize: the acting user must be a member of the target workspace — no
  // cross-workspace binding even with a validly-signed state.
  const role = await workspacesService.getMemberRole(session.user.id, decoded.workspaceId);
  if (!role) return settingsRedirect('install_error');

  try {
    await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: decoded.workspaceId,
      installationId,
    });
  } catch {
    // Provider/config failure (e.g. GITHUB_APP_ID/PRIVATE_KEY unset) — surface a
    // clean banner, never a 500.
    return settingsRedirect('install_error');
  }

  return settingsRedirect('installed');
}
