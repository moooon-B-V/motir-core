// GitHub App install / manage link helpers (Story 7.10 · MOTIR-895). Pure URL
// builders — no I/O, no secrets. The App-install grant (Grant 2) happens
// ENTIRELY on GitHub; Motir only links OUT to it (repo selection is changed on
// GitHub's install screen, never faked in-app — the design's honesty rule).
//
// `GITHUB_APP_SLUG` is the public slug of the registered Motir GitHub App
// (MOTIR-890). When it is unset — a self-hosted deployment that has not
// registered its own App — the install link is null and the UI omits the
// App-install affordance (the connect flow's identity grant still works).

const APP_SLUG_ENV = 'GITHUB_APP_SLUG';

/**
 * The public URL that opens GitHub's "install this App / choose repositories"
 * screen, or `null` when no App slug is configured. When a signed `state` is
 * given (MOTIR-1588), it is carried on the URL so GitHub echoes it back to the
 * Setup URL after install, letting the setup handler bind the installation to
 * the acting workspace (`lib/github/installState.ts`).
 */
export function githubAppInstallUrl(state?: string): string | null {
  const slug = process.env[APP_SLUG_ENV];
  if (!slug) return null;
  const base = `https://github.com/apps/${slug}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/**
 * The "manage this installation on GitHub" URL for an EXISTING installation —
 * where the workspace admin changes which repositories the App can read.
 * Derived from the installation's account: an organization installation is
 * managed under the org's settings, a user installation under the user's.
 */
export function githubInstallationManageUrl(args: {
  accountLogin: string;
  accountType: string;
  installationId: string;
}): string {
  const { accountLogin, accountType, installationId } = args;
  if (accountType.toLowerCase() === 'organization') {
    return `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`;
  }
  return `https://github.com/settings/installations/${installationId}`;
}
