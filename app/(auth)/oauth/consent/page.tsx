import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { redirectIfOrganizationSuspended } from '@/lib/organizations/suspensionRedirect';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { projectsService } from '@/lib/services/projectsService';
import { oauthAuthorizeNext } from '@/lib/oauth/authorizeReturn';
import { OAuthConsentRequestInvalidError } from '@/lib/oauth/errors';
import { ConsentScreen } from '../_components/ConsentScreen';
import { ConsentRefused } from '../_components/ConsentRefused';

// `/oauth/consent` — where the OAuth provider sends a signed-in person to decide
// whether an MCP client may connect (Story MOTIR-6973 · Subtask MOTIR-6985),
// built to `design/auth/oauth-consent.mock.html`. Nobody navigates here inside
// Motir: its only door is the authorize endpoint's redirect, carrying the request
// the provider SIGNED (`…&exp=…&sig=…`).
//
// IT LIVES IN `(auth)`, NOT `(authed)`, for `/device`'s reason: the `(authed)`
// layout redirects, and this page must render its own refused and no-workspace
// states.
//
// ⚠️ AND IT IS NOT IN `proxy.ts`'s MATCHER, although the card asked for that.
// The proxy's bounce sets `next` to the PATHNAME alone, which would drop the
// signed request — the one thing this page cannot re-derive — and a signed-out
// visitor would come back from sign-in to an empty consent page. The signed-out
// hand-off is owned here instead: the request is turned back into the AUTHORIZE
// URL it came from (`oauthAuthorizeNext`, the sign-in page's own converter), so
// signing in returns to authorize, which re-validates it and lands here again
// with a fresh signature. That is the "comes back to the same pending request"
// the acceptance criteria ask for, and it is proven by the route test.
//
// A SERVER SHELL over a client island: the request is read and verified HERE,
// from the provider's signature and the client's registration
// (`describeConsentRequest`) — the app name and redirect are never taken from
// the query string. A request that does not verify renders the refused page
// (design Panel 7) and redirects nowhere.

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = toSearchParams(await searchParams);
  const signInNext = oauthAuthorizeNext(params);
  const signInHref = signInNext
    ? `/sign-in?${new URLSearchParams({ next: signInNext }).toString()}`
    : '/sign-in';

  const session = await getSession();
  if (!session) redirect(signInHref);

  let request;
  try {
    request = await oauthConnectionsService.describeConsentRequest(
      session.user.id,
      params.toString(),
    );
  } catch (err) {
    if (err instanceof OAuthConsentRequestInvalidError) {
      return <ConsentRefused problem={err.reason} />;
    }
    throw err;
  }

  // The pickers open on what the person is working in (MOTIR-4876's rule, one
  // tier down): the active workspace, then its active project.
  const ctx = await redirectIfOrganizationSuspended(getWorkspaceContext());
  const activeProject = ctx
    ? await projectsService.getActiveProject(ctx.userId, ctx.workspaceId)
    : null;

  return (
    <ConsentScreen
      oauthQuery={params.toString()}
      request={request}
      user={{ name: session.user.name, email: session.user.email }}
      activeWorkspaceId={ctx?.workspaceId ?? null}
      activeProjectId={activeProject?.id ?? null}
      signInHref={signInHref}
    />
  );
}

function toSearchParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      out.append(name, v);
    }
  }
  return out;
}
