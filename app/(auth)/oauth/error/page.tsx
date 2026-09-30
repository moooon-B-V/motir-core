import { ConsentRefused, consentProblemFrom } from '../_components/ConsentRefused';

// `/oauth/error` — a connection request refused before it could reach consent
// (Story MOTIR-6973 · Subtask MOTIR-6985, design Panel 7). The authorize policy
// (`lib/auth/mcpOAuthPolicy.ts`) sends a request here when its CLIENT is unknown
// or disabled, or its `redirect_uri` is one that client never registered — the
// cases where the only address on hand may be an attacker's, so the refusal is
// Motir's own page and never a redirect to the app.
//
// It reads two display values from the URL and trusts neither: `error` picks
// which sentence to show (anything unknown shows the most general one), and
// `host` is rendered as text in the unregistered-redirect sentence. Neither is
// followed. It needs no session: a refused request is refused for anyone.

export default async function OAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; host?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return (
    <ConsentRefused problem={consentProblemFrom(first(params.error))} host={first(params.host)} />
  );
}
