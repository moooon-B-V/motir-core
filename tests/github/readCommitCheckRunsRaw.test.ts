import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { readCommitCheckRuns } from '@/lib/github/checkRuns';
import { stubBothAppCredentials } from '../helpers/appCredentials';

// THE HOST READ KEEPS THE RAW CONCLUSION (§4 SIXTH AMENDMENT, MOTIR-6846). The
// normalized `conclusion` folds `cancelled` / `timed_out` into `failure`, which every
// CI reader relies on; `rawConclusion` beside it is what a merge-queue exit is judged
// by, and the url + completion time are what an attempt records about its check.

const HEAD_SHA = 'b'.repeat(40);
const COMPLETED_AT = '2026-09-28T15:44:02Z';

function run(name: string, status: string, conclusion: string | null) {
  return {
    name,
    status,
    conclusion,
    check_suite: { id: 11 },
    html_url: `https://github.com/acme-corp/acme/runs/${name}`,
    completed_at: status === 'completed' ? COMPLETED_AT : null,
  };
}

beforeEach(() => {
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'moooon');
  stubBothAppCredentials();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/access_tokens'))
        return new Response(
          JSON.stringify({
            token: 'ghs_raw',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 },
        );
      if (url.includes('/check-runs'))
        return new Response(
          JSON.stringify({
            total_count: 4,
            check_runs: [
              run('TypeScript', 'completed', 'timed_out'),
              run('Lint', 'completed', 'cancelled'),
              run('Unit', 'completed', 'failure'),
              run('E2E', 'in_progress', null),
            ],
          }),
          { status: 200 },
        );
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('readCommitCheckRuns reports the RAW conclusion beside the normalized one', () => {
  it('a timed-out, a cancelled and a failed run all read `failure`, each keeping its own raw value', async () => {
    const runs = await readCommitCheckRuns('inst-raw', 'acme-corp', 'acme', HEAD_SHA);
    expect(runs).not.toBeNull();
    const byName = new Map(runs!.map((r) => [r.checkName, r]));
    expect(byName.get('TypeScript')).toMatchObject({
      conclusion: 'failure',
      rawConclusion: 'timed_out',
      url: 'https://github.com/acme-corp/acme/runs/TypeScript',
      completedAt: new Date(COMPLETED_AT),
    });
    expect(byName.get('Lint')).toMatchObject({ conclusion: 'failure', rawConclusion: 'cancelled' });
    expect(byName.get('Unit')).toMatchObject({ conclusion: 'failure', rawConclusion: 'failure' });
  });

  it('a run still in progress has no raw conclusion and no completion time', async () => {
    const runs = await readCommitCheckRuns('inst-raw', 'acme-corp', 'acme', HEAD_SHA);
    expect(runs!.find((r) => r.checkName === 'E2E')).toMatchObject({
      conclusion: 'pending',
      rawConclusion: null,
      completedAt: null,
    });
  });
});
