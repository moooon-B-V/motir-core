import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { DeviceApproval } from './_components/DeviceApproval';
import { DeviceSignedOut } from './_components/DeviceSignedOut';

// `/device` — the browser half of `motir login` (Story MOTIR-1863 · Subtask
// MOTIR-1867), built to `design/cli-connect/` (Panels 0–8). The terminal prints a
// code and a URL, the human comes here, and the CLI polls until this page resolves
// the grant one way or the other.
//
// IT LIVES IN `(auth)`, NOT `(authed)` — the design's placement decision, made from
// shipped reality. The `(authed)` layout `redirect('/sign-in')`s, which would make
// the signed-out arrival (the COMMON case: the CLI opens a browser that has no
// Motir session) unrenderable, and the app shell cannot render for a visitor with
// no session anyway. `/reset-password/new` is the shipped precedent: arrive by URL
// bearing a code, do one thing, leave. It gets no nav entry — its door is the CLI.
//
// ⚠️ DO NOT ADD `/device` TO `proxy.ts`'s MATCHER. That bounce sets `next` to
// `request.nextUrl.pathname` alone and DROPS the query string, which would silently
// lose `?user_code=` — the one value this page cannot re-derive. The signed-out
// hand-off is owned here instead (`DeviceSignedOut`), where the code can be encoded
// into `next` and carried back.
//
// A SERVER SHELL over a client island, the account-settings pattern: the session
// gate and the workspace reads happen here; every interaction (the claim, approve,
// deny, and the six states) lives in `DeviceApproval`.
//
// Dynamic by construction — `getSession()` reads headers and the page branches on a
// search param, so there is nothing to prerender.
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string | string[] }>;
}) {
  const params = await searchParams;
  // `verification_uri_complete` sets it once, but a hand-edited URL can repeat the
  // key; take the first and let the server reject it if it is nonsense.
  const raw = params.user_code;
  const userCode = (Array.isArray(raw) ? raw[0] : raw) ?? '';

  const session = await getSession();
  // NOT a redirect. The hand-off is a STATE of this page (design Panel 8): it names
  // what is waiting, then links to sign-in with the code encoded into `next` so the
  // return lands back here with the code still in hand.
  if (!session) return <DeviceSignedOut userCode={userCode} />;

  // The same org → workspace tree the token create-modal offers, for the same
  // reason: approval MINTS a token bound to one workspace, so the choice is over
  // exactly the workspaces this user may bind one in. The server re-asserts
  // membership on approve regardless of what the form posts.
  const [scopeOrgs, ctx] = await Promise.all([
    apiTokensService.listScopeOptions(session.user.id),
    getWorkspaceContext(),
  ]);
  const workspaces = scopeOrgs.flatMap((org) =>
    org.workspaces.map((workspace) => ({
      id: workspace.id,
      // "moooon · Motir" — org THEN workspace, because a workspace name alone is
      // ambiguous across orgs and this is a security decision the reader is making.
      label: `${org.name} · ${workspace.name}`,
    })),
  );

  return (
    <DeviceApproval
      initialUserCode={userCode}
      user={{
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
      }}
      workspaces={workspaces}
      activeWorkspaceId={ctx?.workspaceId ?? null}
    />
  );
}
