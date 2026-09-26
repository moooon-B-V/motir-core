import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Story MOTIR-683 · MOTIR-6519 (AC4) — the separate "Motir Agent" link is gone.
// `docs/decisions/hosted-run-one-github-app.md` settled on ONE GitHub App per
// repository, and `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` has a
// hosted run write with that App's installation token, never a person's. So no
// second authorization table, service, route, error or env name may creep back.
// The decision records keep the history and are not scanned; neither is this
// file.

const FORBIDDEN = [
  'GithubAgentAuthorization',
  'github_agent_authorization',
  'githubAgentAuth',
  'GithubAgentAppNotConfiguredError',
  'GithubAgentNotLinkedError',
  'GithubAgentLinkStatus',
  'GITHUB_AGENT_APP_',
  'api/github/agent/',
];

const SCANNED = [
  'app',
  'lib',
  'prisma',
  'tests',
  'scripts',
  '.env.example',
  'docs/decisions/permission-inventory.md',
];

describe('the Motir Agent link is removed (MOTIR-6519 AC4)', () => {
  it.each(FORBIDDEN)('no tracked file outside the decision records mentions %s', (needle) => {
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-F',
          needle,
          '--',
          ...SCANNED,
          ':(exclude)tests/github/motirAgentLinkRemoved.test.ts',
        ],
        { encoding: 'utf8' },
      );
    } catch (err) {
      // `git grep` exits 1 when nothing matches — the outcome we want.
      if ((err as { status?: number }).status === 1) return;
      throw err;
    }
    expect(hits.trim().split('\n')).toEqual([]);
  });

  it('no route directory exists under app/api/github/agent', () => {
    const tracked = execFileSync('git', ['ls-files', 'app/api/github/agent'], { encoding: 'utf8' });
    expect(tracked.trim()).toBe('');
  });
});
