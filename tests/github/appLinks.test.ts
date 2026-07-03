import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubAppInstallUrl, githubInstallationManageUrl } from '@/lib/github/appLinks';

// Story 7.10 · MOTIR-895 — the GitHub App install/manage link builders. Pure
// functions (no I/O); the install URL reads `GITHUB_APP_SLUG` at call time so a
// self-hosted deployment that never registers an App simply gets a null link.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('githubAppInstallUrl', () => {
  it('builds the public install URL from the configured App slug', () => {
    vi.stubEnv('GITHUB_APP_SLUG', 'motir-app');
    expect(githubAppInstallUrl()).toBe('https://github.com/apps/motir-app/installations/new');
  });

  it('returns null when no App slug is configured (self-host, App not registered)', () => {
    vi.stubEnv('GITHUB_APP_SLUG', '');
    expect(githubAppInstallUrl()).toBeNull();
  });

  it('carries a signed state as a url-encoded ?state param (MOTIR-1588)', () => {
    vi.stubEnv('GITHUB_APP_SLUG', 'motir-app');
    const url = githubAppInstallUrl('abc.def+/=');
    expect(url).toBe('https://github.com/apps/motir-app/installations/new?state=abc.def%2B%2F%3D');
  });
});

describe('githubInstallationManageUrl', () => {
  it('points an ORGANIZATION installation at the org settings page', () => {
    expect(
      githubInstallationManageUrl({
        accountLogin: 'moooon',
        accountType: 'Organization',
        installationId: '4242',
      }),
    ).toBe('https://github.com/organizations/moooon/settings/installations/4242');
  });

  it('points a USER installation at the personal settings page', () => {
    expect(
      githubInstallationManageUrl({
        accountLogin: 'zhuyue',
        accountType: 'User',
        installationId: '99',
      }),
    ).toBe('https://github.com/settings/installations/99');
  });

  it('is case-insensitive on the account type discriminator', () => {
    expect(
      githubInstallationManageUrl({
        accountLogin: 'acme',
        accountType: 'organization',
        installationId: '7',
      }),
    ).toBe('https://github.com/organizations/acme/settings/installations/7');
  });
});
