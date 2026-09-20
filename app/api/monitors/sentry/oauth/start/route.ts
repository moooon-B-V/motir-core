import { NextResponse, type NextRequest } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { shouldUseSecureCookies } from '@/lib/e2eProdHarness';
import {
  MONITOR_CONNECT_STATE_COOKIE,
  MONITOR_CONNECT_STATE_TTL_SECONDS,
  encodeMonitorConnectState,
  mintMonitorConnectNonce,
} from '@/lib/monitors/connectState';
import { missingProviderEnv } from '@/lib/monitors';
import {
  parseMonitorReturnSurfaceId,
  resolveMonitorReturnPath,
} from '@/lib/monitors/returnSurface';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';

// GET /api/monitors/sentry/oauth/start (Story MOTIR-4926 · MOTIR-5260) — step 1
// of the monitor connect grant.
//
// It asserts `integration:manage` on the TARGET PROJECT, mints a CSRF nonce,
// stashes `{ nonce, projectId, returnSurfaceId }` in an httpOnly cookie, and
// redirects to Sentry's external-install URL for Motir's public integration.
//
// ⚠️ THE PROJECT IS RESOLVED HERE, WHERE THE PERMISSION IS ASSERTED, AND CARRIED
// IN THE COOKIE. The callback never reads a project id from its query string:
// the flow "starts with a request to Motir, so it can set a cookie — and the
// origin therefore never leaves this server at all"
// (`lib/github/returnSurface.ts`, the same carrier one provider over). An id that
// does not take the round trip cannot be swapped on it.
//
// Routes are HTTP-only (CLAUDE.md): read the session, resolve the project, gate,
// redirect.

/** Sentry's external-install page for a public integration. Read at call time so
 *  a deployment that never registered the integration (MOTIR-5257) cannot reach
 *  the flow rather than crashing on boot. */
function externalInstallUrl(nonce: string): string | null {
  const slug = process.env['SENTRY_APP_SLUG'];
  if (!slug) return null;
  const base = process.env['SENTRY_WEB_BASE_URL']?.replace(/\/+$/, '') ?? 'https://sentry.io';
  const url = new URL(`${base}/sentry-apps/${encodeURIComponent(slug)}/external-install/`);
  // The nonce travels so the callback can double-submit it AGAINST the cookie.
  // ⚠️ Whether the provider preserves it is a documented expectation and not a
  // read — `lib/monitors/connectState.ts` states why the gate does not depend on
  // the echo, and what still holds when it is absent.
  url.searchParams.set('state', nonce);
  return url.toString();
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const projectKey = req.nextUrl.searchParams.get('project');
  const returnSurfaceId =
    parseMonitorReturnSurfaceId(req.nextUrl.searchParams.get('return')) ?? 'projectMonitoring';
  const landing = `${resolveBaseUrlTrimmed()}${resolveMonitorReturnPath(returnSurfaceId)}`;

  if (!projectKey) return NextResponse.redirect(`${landing}?monitor=no_project`);

  // `getByKey` is tenant-gated and `assertPermission` refuses a project the actor
  // may not manage — so an unknown key and a forbidden one are the same answer,
  // which is the no-existence-leak posture the project-scoped services keep.
  let projectId: string;
  try {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'integration:manage');
    projectId = project.id;
  } catch {
    return NextResponse.redirect(`${landing}?monitor=forbidden`);
  }

  // ⚠️ REFUSE BEFORE THE REDIRECT (MOTIR-5831) — the whole point is that this
  // happens BEFORE a nonce is minted, before a cookie is set, and before anybody
  // is sent to the provider's consent screen.
  //
  // The defect: `SENTRY_APP_CLIENT_SECRET` was absent from production for seven
  // days and this route did not care, because it built the install URL from the
  // SLUG alone. So Connect worked, Sentry's consent screen rendered, the person
  // approved an install INSIDE THEIR OWN Sentry organisation — and the failure
  // arrived one step later, in the grant exchange, as an error about OUR
  // environment. Everything up to that point was their work. A refusal here costs
  // them one click.
  //
  // ⚠️ IT ASKS THE PROVIDER, and that is the load-bearing half. A literal list of
  // Sentry's variable names in this route would be the second home that drifts
  // from the adapter's reads — which is the shape of the original bug one level
  // up. The names live beside `appCredentials()`; this route asks the seam.
  //
  // It sits AFTER the permission gate deliberately: only an actor who may manage
  // this project's integrations learns anything about the deployment's
  // configuration, which keeps the no-existence-leak posture the checks above it
  // hold. `not_configured` already maps to an `info` banner
  // (`lib/monitors/returnBanner.ts`), so there is no new copy and no new UI.
  if (missingProviderEnv('sentry').length > 0) {
    return NextResponse.redirect(`${landing}?monitor=not_configured`);
  }

  const nonce = mintMonitorConnectNonce();
  // Kept as a belt: the check above makes this unreachable for a provider that
  // DECLARES the slug, but a provider registered under `sentry` that declares
  // nothing (the E2E fake) reaches here, and the null guard is what still refuses
  // if it has no install URL to offer.
  const installUrl = externalInstallUrl(nonce);
  if (!installUrl) return NextResponse.redirect(`${landing}?monitor=not_configured`);

  const res = NextResponse.redirect(installUrl);
  // `sameSite: 'lax'` so the cookie survives the provider's top-level GET
  // redirect back to the callback — a strict cookie would be dropped and every
  // callback would read as a state mismatch.
  res.cookies.set(
    MONITOR_CONNECT_STATE_COOKIE,
    encodeMonitorConnectState({
      nonce,
      projectId,
      returnSurfaceId,
      issuedAt: Date.now(),
    }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: shouldUseSecureCookies(),
      path: '/',
      maxAge: MONITOR_CONNECT_STATE_TTL_SECONDS,
    },
  );
  return res;
}
