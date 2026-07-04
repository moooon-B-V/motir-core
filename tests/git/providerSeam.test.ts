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

  it('throws UnknownGitProviderError for a provider not yet registered', () => {
    // GitLab (7.23) implements the SAME interface + registers itself; until then
    // resolving it is an explicit typed error, not a silent undefined.
    expect(() => getGitProvider('gitlab' as GitProviderId)).toThrow(UnknownGitProviderError);
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
