import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  getGitProvider,
  registeredGitProviderIds,
  UnknownGitProviderError,
  type GitProviderId,
} from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// The GitProvider seam (Story 7.10 · MOTIR-891) — the registry + the GitHub
// implementation's pure normalizers. No DB; importing `@/lib/git` registers the
// GitHub provider via its module side-effect.

describe('git provider registry', () => {
  it('registers GitHub as a resolvable provider', () => {
    expect(registeredGitProviderIds()).toContain('github');
    expect(getGitProvider('github').id).toBe('github');
  });

  it('registers GitLab as a resolvable provider (7.23 · MOTIR-1474)', () => {
    // GitLab implements the SAME interface + registers itself — additivity proven.
    expect(registeredGitProviderIds()).toContain('gitlab');
    expect(getGitProvider('gitlab').id).toBe('gitlab');
  });

  it('throws UnknownGitProviderError for a provider that is not registered', () => {
    expect(() => getGitProvider('bitbucket' as GitProviderId)).toThrow(UnknownGitProviderError);
  });
});

const github = getGitProvider('github');

function prEvent(over: Record<string, unknown> = {}): unknown {
  return {
    action: 'opened',
    repository: { id: 555 },
    pull_request: {
      number: 7,
      state: 'open',
      merged: false,
      title: 'feat: a thing',
      head: { ref: 'subtask/MOTIR-891-github-app' },
      ...over,
    },
  };
}

describe('github.parseChangeRequestEvent', () => {
  it('normalizes an opened pull_request payload', () => {
    expect(github.parseChangeRequestEvent(prEvent())).toEqual({
      providerRepoId: '555',
      number: 7,
      state: 'open',
      merged: false,
      headRef: 'subtask/MOTIR-891-github-app',
      title: 'feat: a thing',
    });
  });

  it('marks a merged PR closed + merged', () => {
    const cr = github.parseChangeRequestEvent(prEvent({ state: 'closed', merged: true }));
    expect(cr).toMatchObject({ state: 'closed', merged: true });
  });

  it('marks a closed-unmerged PR closed but not merged', () => {
    const cr = github.parseChangeRequestEvent(prEvent({ state: 'closed', merged: false }));
    expect(cr).toMatchObject({ state: 'closed', merged: false });
  });

  it('returns null for a non-change-request payload', () => {
    expect(github.parseChangeRequestEvent({ zen: 'hi', repository: { id: 1 } })).toBeNull();
    expect(github.parseChangeRequestEvent(null)).toBeNull();
    // A PR payload missing the head ref is unusable → null.
    expect(github.parseChangeRequestEvent(prEvent({ head: {} }))).toBeNull();
  });
});

describe('github.changeRequestLifecycle', () => {
  const base = { providerRepoId: '1', number: 1, headRef: 'b', title: null } as const;

  it('maps open → in_review, merged → done, closed-unmerged → todo', () => {
    expect(github.changeRequestLifecycle({ ...base, state: 'open', merged: false })).toBe(
      'in_review',
    );
    expect(github.changeRequestLifecycle({ ...base, state: 'closed', merged: true })).toBe('done');
    expect(github.changeRequestLifecycle({ ...base, state: 'closed', merged: false })).toBe('todo');
  });
});

describe('github.parseCiStatusEvent', () => {
  it('normalizes a completed check_run conclusion', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: {
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        name: 'ci',
        check_suite: { head_branch: 'feat/x' },
        pull_requests: [{ number: 7 }],
      },
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'success',
      context: 'ci',
      prNumbers: [7],
      headBranch: 'feat/x',
    });
  });

  it('normalizes a completed check_suite conclusion (aggregate; app slug as context)', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_suite: {
        head_sha: 'abc123',
        head_branch: 'feat/x',
        status: 'completed',
        conclusion: 'failure',
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 7 }, { number: 8 }],
      },
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'failure',
      context: 'github-actions',
      prNumbers: [7, 8],
      headBranch: 'feat/x',
    });
  });

  it('reports an in-progress check_run as pending', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: { head_sha: 'abc', status: 'in_progress', conclusion: null, name: 'ci' },
    });
    expect(ev).toMatchObject({ conclusion: 'pending' });
  });

  it('maps failing conclusions (timed_out) to failure', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: { head_sha: 'abc', status: 'completed', conclusion: 'timed_out', name: 'ci' },
    });
    expect(ev).toMatchObject({ conclusion: 'failure' });
  });

  it('normalizes a legacy commit-status payload', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      sha: 'deadbeef',
      state: 'failure',
      context: 'continuous-integration/ci',
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'deadbeef',
      conclusion: 'failure',
      context: 'continuous-integration/ci',
      prNumbers: [],
      headBranch: null,
    });
  });

  it('returns null for an unrelated payload', () => {
    expect(github.parseCiStatusEvent({ repository: { id: 9 }, foo: 1 })).toBeNull();
    expect(github.parseCiStatusEvent({ sha: 'x', state: 'success' })).toBeNull(); // no repo id
  });
});

describe('github.fetchRepoTarball (MOTIR-1500)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('mints the token, GETs /repos/{owner}/{name}/tarball/{ref} with the Bearer, and returns the bytes', async () => {
    const tarballBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x42, 0x99]); // gzip magic + noise
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_tarball',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/tarball/')) {
        return new Response(tarballBytes, { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const buf = await github.fetchRepoTarball('inst-1', 'moooon', 'acme', 'main');
    expect(new Uint8Array(buf)).toEqual(tarballBytes);

    // The tarball call hit the right URL with the minted installation token.
    const tarballCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/tarball/'));
    expect(tarballCall).toBeTruthy();
    const [tarballUrl, init] = tarballCall!;
    expect(tarballUrl).toBe('https://api.github.com/repos/moooon/acme/tarball/main');
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: 'Bearer ghs_tarball',
    });
  });

  it('throws on a non-OK tarball response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        if (String(url).includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('nope', { status: 404 });
      }),
    );
    await expect(github.fetchRepoTarball('inst-1', 'moooon', 'acme', 'main')).rejects.toThrow(
      /tarball endpoint returned 404/,
    );
  });
});

describe('github.parsePushEvent (MOTIR-893)', () => {
  const SHA = 'f'.repeat(40);

  it('normalizes a branch push (short branch name + head sha)', () => {
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/main',
        after: SHA,
        repository: { id: 555 },
      }),
    ).toEqual({ providerRepoId: '555', branch: 'main', headSha: SHA });
  });

  it('keeps a slashed branch name intact', () => {
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/subtask/MOTIR-893-feed',
        after: SHA,
        repository: { id: 555 },
      }),
    ).toMatchObject({ branch: 'subtask/MOTIR-893-feed' });
  });

  it('returns null for a tag push, a branch deletion, and a malformed body', () => {
    expect(
      github.parsePushEvent({ ref: 'refs/tags/v1.0.0', after: SHA, repository: { id: 555 } }),
    ).toBeNull();
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/main',
        deleted: true,
        after: '0'.repeat(40),
        repository: { id: 555 },
      }),
    ).toBeNull();
    expect(github.parsePushEvent({ ref: 'refs/heads/main', after: SHA })).toBeNull(); // no repo
    expect(github.parsePushEvent('not an object')).toBeNull();
  });

  it('normalizes a missing/empty after to headSha null', () => {
    expect(github.parsePushEvent({ ref: 'refs/heads/main', repository: { id: 555 } })).toEqual({
      providerRepoId: '555',
      branch: 'main',
      headSha: null,
    });
  });
});

// --- CI-minutes metering capability (Story MOTIR-1775 · MOTIR-1896) ----------
// `docs/decisions/ci-minutes-allowance.md` §5.6 makes these OPTIONAL on the
// seam: GitHub is the only host whose compute Motir pays for, because Motir
// creates repositories only in its own GitHub org. GitLab is reachable through
// connect-existing only — a namespace the user owns and GitLab bills them for.

describe('the metering capability is GitHub-only, by design (§5.6)', () => {
  it('GitHub declares it; GitLab does not', () => {
    expect(typeof github.parseWorkflowRunEvent).toBe('function');
    expect(typeof github.fetchWorkflowRunJobs).toBe('function');
    expect(getGitProvider('gitlab').parseWorkflowRunEvent).toBeUndefined();
    expect(getGitProvider('gitlab').fetchWorkflowRunJobs).toBeUndefined();
  });

  it('the runner-FLEET capability is scoped the same way (MOTIR-1920)', () => {
    // Same structural reason, one card later: the fleet boots runners only for
    // repositories Motir hosts, and Motir hosts none on GitLab — so there is no
    // GitLab job it would ever provision for. `parseWorkflowJobEvent`'s own
    // behaviour is pinned in `tests/ciFleet/workflowJobEvent.test.ts`; what is
    // asserted here is that it stayed a CAPABILITY rather than becoming a
    // contract every provider must stub.
    expect(typeof github.parseWorkflowJobEvent).toBe('function');
    expect(getGitProvider('gitlab').parseWorkflowJobEvent).toBeUndefined();
  });
});

describe('github.parseWorkflowRunEvent (MOTIR-1896)', () => {
  function runDelivery(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: 'completed',
      repository: { id: 555, name: 'acme-web', owner: { login: 'motir-projects' } },
      workflow_run: {
        id: 7001,
        name: 'CI',
        run_attempt: 2,
        run_started_at: '2026-07-30T11:00:00Z',
        updated_at: '2026-07-30T12:00:00Z',
      },
      ...over,
    };
  }

  it('normalizes a completed run, taking the owner from the RUN payload (§5.5)', () => {
    expect(github.parseWorkflowRunEvent!(runDelivery())).toEqual({
      providerRepoId: '555',
      runId: '7001',
      attempt: 2,
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      workflowName: 'CI',
      completedAt: new Date('2026-07-30T12:00:00Z'),
    });
  });

  it('returns null for a run that has not completed (§5.7)', () => {
    // The predicate is evaluated at run COMPLETION — that is what makes the
    // repo-transfer edge fall out with no special handling.
    expect(github.parseWorkflowRunEvent!(runDelivery({ action: 'requested' }))).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ action: 'in_progress' }))).toBeNull();
  });

  it('defaults a payload with no run_attempt to attempt 1', () => {
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['run_attempt'];
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({ attempt: 1 });
  });

  it('ignores a nonsensical run_attempt rather than trusting it', () => {
    const delivery = runDelivery();
    (delivery['workflow_run'] as Record<string, unknown>)['run_attempt'] = 0;
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({ attempt: 1 });
  });

  it('falls back to run_started_at when updated_at is absent', () => {
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['updated_at'];
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({
      completedAt: new Date('2026-07-30T11:00:00Z'),
    });
  });

  it('REFUSES a run with no usable timestamp rather than guessing one', () => {
    // Without an instant the run cannot be assigned a period or a rate
    // effective-date, and inventing one would silently misfile real spend.
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['updated_at'];
    delete (delivery['workflow_run'] as Record<string, unknown>)['run_started_at'];
    expect(github.parseWorkflowRunEvent!(delivery)).toBeNull();
    (delivery['workflow_run'] as Record<string, unknown>)['updated_at'] = 'not-a-date';
    expect(github.parseWorkflowRunEvent!(delivery)).toBeNull();
  });

  it('returns null for a malformed or unrelated payload', () => {
    expect(github.parseWorkflowRunEvent!('not an object')).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ workflow_run: undefined }))).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ repository: undefined }))).toBeNull();
    expect(
      github.parseWorkflowRunEvent!(runDelivery({ repository: { id: 555, name: 'x' } })),
    ).toBeNull(); // no owner login
  });
});

describe('github.fetchWorkflowRunJobs (MOTIR-1896)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubJobs(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_jobs',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads the ATTEMPT-scoped jobs endpoint, so a re-run does not double-count', async () => {
    const fetchMock = stubJobs({
      jobs: [
        {
          id: 42,
          name: 'build',
          started_at: '2026-07-30T11:00:00Z',
          completed_at: '2026-07-30T11:05:00Z',
          labels: ['ubuntu-latest'],
        },
      ],
    });

    const jobs = await github.fetchWorkflowRunJobs!(
      '9001',
      'motir-projects',
      'acme-web',
      '7001',
      2,
    );

    expect(jobs).toEqual([
      {
        id: '42',
        name: 'build',
        startedAt: new Date('2026-07-30T11:00:00Z'),
        completedAt: new Date('2026-07-30T11:05:00Z'),
        labels: ['ubuntu-latest'],
      },
    ]);
    // `/runs/{id}/jobs` would return EVERY attempt's jobs; the attempt-scoped
    // path is what keeps a re-run billing only its own compute.
    const jobsUrl = String(
      fetchMock.mock.calls.find((c) => !String(c[0]).includes('access_tokens'))?.[0],
    );
    expect(jobsUrl).toContain('/repos/motir-projects/acme-web/actions/runs/7001/attempts/2/jobs');
  });

  it('does NOT use the closing-down /timing endpoint (§5.8)', async () => {
    const fetchMock = stubJobs({ jobs: [] });
    await github.fetchWorkflowRunJobs!('9001', 'motir-projects', 'acme-web', '7001', 1);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('/timing');
    }
  });

  it('normalizes a job with missing timestamps rather than dropping it', async () => {
    // Keeping the row makes "why did this run meter nothing?" answerable from
    // the job list; the arithmetic is what skips it.
    stubJobs({ jobs: [{ id: 43, name: 'queued', labels: [] }] });
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([
      { id: '43', name: 'queued', startedAt: null, completedAt: null, labels: [] },
    ]);
  });

  it('drops an entry with no usable id, and tolerates a missing jobs array', async () => {
    stubJobs({ jobs: [{ name: 'nameless' }, 'garbage'] });
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([]);
    stubJobs({});
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    stubJobs({ message: 'Not Found' }, 404);
    await expect(github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).rejects.toThrow(
      /workflow-jobs endpoint returned 404/,
    );
  });
});

describe('github.fetchOrgComputeUsage (MOTIR-1896 — the reconciliation read)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the enhanced-billing usage endpoint with the org-billing token', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            usageItems: [
              {
                repositoryName: 'acme-web',
                sku: 'Actions Linux',
                quantity: 120,
                unitType: 'minutes',
                date: '2026-07-15',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const lines = await github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 'ghp_audit');

    expect(lines).toEqual([
      {
        repositoryName: 'acme-web',
        sku: 'Actions Linux',
        quantity: 120,
        unitType: 'minutes',
        date: '2026-07-15',
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.github.com/organizations/motir-projects/settings/billing/usage?year=2026&month=7',
    );
    // The org-billing credential, NOT an installation token: an installation
    // token cannot read org billing at all.
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ghp_audit' });
  });

  it('drops malformed usage lines and throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ usageItems: [{ sku: 'Actions Linux' }, 'garbage'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    expect(await github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 't')).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    await expect(github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 't')).rejects.toThrow(
      /billing-usage endpoint returned 403/,
    );
  });
});
