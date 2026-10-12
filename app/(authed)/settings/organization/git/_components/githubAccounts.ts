// The shapes the GitHub half of Settings → Organisation → Git passes between its
// server page and its client islands (Story MOTIR-8216 · MOTIR-8223). Plain
// props: the page reads, these carry, the islands render.

/** One GitHub account as the room names it: enough to title a picker and to
 *  address the connect and disconnect routes. */
export interface GithubAccountRef {
  /** GitHub's installation id — the key every account route takes. */
  installationId: string;
  accountLogin: string;
  /** GitHub's own word: `Organization` or `User`. */
  accountType: string;
}

/** One account linked to THIS organisation, as the `GitHub accounts` card lists it. */
export interface LinkedGithubAccount extends GithubAccountRef {
  /** How many of the account's repositories this organisation connected. */
  repoCount: number;
  /** That account's OWN installation settings on GitHub. */
  manageUrl: string;
}

/** The copy key for an account's type: an organisation, or a person. */
export function accountTypeKey(accountType: string): 'organization' | 'personal' {
  return accountType.toLowerCase() === 'organization' ? 'organization' : 'personal';
}

/** The disc the account rows draw when no avatar is stored: its first letter. */
export function accountInitial(login: string): string {
  return (login.trim()[0] ?? '?').toUpperCase();
}
