import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitProvider, CHANGED_FILES_MAX, CHANGED_FILES_TIMEOUT_MS } from '@/lib/git';
import { maxDuration } from '@/app/api/internal/ai/repo-changes/route';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import {
  GitlabConnectionNotFoundError,
  GitlabOAuthNotConfiguredError,
  GitlabTokenRefreshError,
} from '@/lib/gitlab/errors';

// `listChangedFiles` on the GitProvider seam (Story MOTIR-6617 · MOTIR-6619).
//
// Both providers are driven against RECORDED host payloads — the compare
// responses GitHub and GitLab actually send, trimmed to the fields the
// implementations touch plus the ones they must NOT (patch hunks, blob URLs),
// so a regression that starts reading content fails on the payload rather than
// on a hand-built object that never had it.
//
// What is under test: every absence arm is a NAMED result and none throws; a
// rename carries its previous path; the 300-file cap reports `truncated`; and
// nothing credential-shaped reaches the result.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');

const BASE_SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
const MERGE_BASE_SHA = '9a2c6f1e0b1d7c4e5f3a8b9c0d1e2f3a4b5c6d7e';
const HEAD_SHA = '0328041d1152db8ae77652d1618a02e57f745f17';

/** A GitHub `GET /repos/{o}/{n}/compare/{base}...{head}` response, as the host
 *  sends it (trimmed). Three files — one added, one modified, one renamed. */
function githubCompareBody(files: unknown[] = githubThreeFiles()) {
  return {
    url: `https://api.github.com/repos/moooon/acme/compare/main...feat/x`,
    html_url: 'https://github.com/moooon/acme/compare/main...feat/x',
    permalink_url: `https://github.com/moooon/acme/compare/moooon:${BASE_SHA}...moooon:${HEAD_SHA}`,
    base_commit: { sha: BASE_SHA, commit: { message: 'base' } },
    merge_base_commit: { sha: MERGE_BASE_SHA },
    status: 'ahead',
    ahead_by: 2,
    behind_by: 0,
    total_commits: 2,
    commits: [{ sha: '1111111111111111111111111111111111111111' }, { sha: HEAD_SHA }],
    files,
  };
}

function githubThreeFiles() {
  return [
    {
      sha: 'bbcd538c8e72b8c175046e27cc8f907076331401',
      filename: 'lib/new.ts',
      status: 'added',
      additions: 10,
      deletions: 0,
      changes: 10,
      blob_url: `https://github.com/moooon/acme/blob/${HEAD_SHA}/lib/new.ts`,
      raw_url: `https://github.com/moooon/acme/raw/${HEAD_SHA}/lib/new.ts`,
      contents_url: `https://api.github.com/repos/moooon/acme/contents/lib/new.ts?ref=${HEAD_SHA}`,
      patch: '@@ -0,0 +1,10 @@\n+export const secretHunk = 1;',
    },
    {
      sha: 'aacd538c8e72b8c175046e27cc8f907076331401',
      filename: 'lib/changed.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: '@@ -1 +1 @@\n-a\n+b',
    },
    {
      sha: 'ccd538c8e72b8c175046e27cc8f907076331401',
      filename: 'lib/after.ts',
      previous_filename: 'lib/before.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      changes: 0,
    },
  ];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function tokenResponse(): Response {
  return json({
    token: 'ghs_changes_secret',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/** Every non-token fetch answers `reply`; the token mint answers `mint`. */
function stubFetch(
  reply: (url: string) => Response | Promise<Response>,
  mint: () => Response = tokenResponse,
) {
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const u = String(url);
    if (u.includes('/access_tokens')) return mint();
    return reply(u);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the seam declares listChangedFiles as REQUIRED', () => {
  it('both shipped providers implement it', () => {
    expect(typeof github.listChangedFiles).toBe('function');
    expect(typeof gitlab.listChangedFiles).toBe('function');
  });

  it('the host deadline is under the listing route’s maxDuration', () => {
    expect(CHANGED_FILES_TIMEOUT_MS).toBeLessThan(maxDuration * 1000);
  });

  it('the cap is GitHub’s own files[] limit', () => {
    expect(CHANGED_FILES_MAX).toBe(300);
  });
});

describe('github.listChangedFiles', () => {
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

  it('lists the 3 paths a branch changed against main, with their statuses', async () => {
    const fetchMock = stubFetch(() => json(githubCompareBody()));
    const result = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');

    expect(result).toEqual({
      outcome: 'ok',
      base: 'main',
      head: 'feat/x',
      files: [
        { path: 'lib/new.ts', status: 'added' },
        { path: 'lib/changed.ts', status: 'modified' },
        { path: 'lib/after.ts', status: 'renamed', previousPath: 'lib/before.ts' },
      ],
      truncated: false,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });

    const [url, init] = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/compare/'),
    ) as unknown as [string, RequestInit];
    // Three-dot, both refs encoded, and NO paging parameter (unpaged is what
    // makes the last commit the head).
    expect(url).toBe('https://api.github.com/repos/moooon/acme/compare/main...feat%2Fx');
    expect(init.headers).toMatchObject({ authorization: 'Bearer ghs_changes_secret' });
    expect(init.signal).toBeDefined();
  });

  it('folds GitHub’s copied / changed / unchanged words into the seam’s four', async () => {
    stubFetch(() =>
      json(
        githubCompareBody([
          { filename: 'a.ts', status: 'copied', previous_filename: 'src.ts' },
          { filename: 'b.sh', status: 'changed' },
          { filename: 'c.ts', status: 'unchanged' },
          { filename: 'gone.ts', status: 'removed' },
        ]),
      ),
    );
    const result = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    expect(result).toMatchObject({
      outcome: 'ok',
      files: [
        { path: 'a.ts', status: 'added' },
        { path: 'b.sh', status: 'modified' },
        { path: 'c.ts', status: 'modified' },
        { path: 'gone.ts', status: 'removed' },
      ],
    });
  });

  it('a compare AT the host’s 300-file cap is truncated; under it is not', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ filename: `f/${i}.ts`, status: 'modified' }));

    stubFetch(() => json(githubCompareBody(many(300))));
    const capped = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    expect(capped).toMatchObject({ outcome: 'ok', truncated: true });
    expect(capped.outcome === 'ok' && capped.files.length).toBe(300);

    stubFetch(() => json(githubCompareBody(many(299))));
    const under = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    expect(under).toMatchObject({ outcome: 'ok', truncated: false });
    expect(under.outcome === 'ok' && under.files.length).toBe(299);
  });

  it('an identical pair is ok with no files, and head resolves to the merge base', async () => {
    stubFetch(() =>
      json({ ...githubCompareBody([]), commits: [], ahead_by: 0, status: 'identical' }),
    );
    expect(await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'main')).toEqual({
      outcome: 'ok',
      base: 'main',
      head: 'main',
      files: [],
      truncated: false,
      baseSha: BASE_SHA,
      headSha: MERGE_BASE_SHA,
    });
  });

  it('a head ref that does not exist is no_such_ref, not a throw', async () => {
    stubFetch(() =>
      json(
        {
          message: 'Not Found',
          documentation_url: 'https://docs.github.com/rest/commits/commits#compare-two-commits',
        },
        404,
      ),
    );
    await expect(
      github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'no-such-branch'),
    ).resolves.toEqual({ outcome: 'no_such_ref', base: 'main', head: 'no-such-branch' });
  });

  it('a revoked installation (the token endpoint answers 404) is revoked, not a throw', async () => {
    const fetchMock = stubFetch(
      () => json(githubCompareBody()),
      () => json({ message: 'Not Found' }, 404),
    );
    await expect(
      github.listChangedFiles('inst-gone', 'moooon', 'acme', 'main', 'feat/x'),
    ).resolves.toEqual({ outcome: 'revoked', base: 'main', head: 'feat/x' });
    // It never reached the compare endpoint.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/compare/'))).toBe(false);
  });

  it('a credential the compare endpoint refuses is revoked; a rate limit is host_error', async () => {
    stubFetch(() => json({ message: 'Bad credentials' }, 401));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'revoked' });

    stubFetch(() => json({ message: 'Resource not accessible by integration' }, 403));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'revoked' });

    stubFetch(() =>
      json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    );
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error' });
  });

  it('an App not configured on this deployment is not_connected', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    stubFetch(() => json(githubCompareBody()));
    await expect(
      github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).resolves.toEqual({ outcome: 'not_connected', base: 'main', head: 'feat/x' });
  });

  it('a diff the host will not build is too_large', async () => {
    stubFetch(() =>
      json({ message: 'Server Error: Sorry, this diff is taking too long to generate.' }, 422),
    );
    await expect(
      github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).resolves.toEqual({ outcome: 'too_large', base: 'main', head: 'feat/x' });
  });

  it('a host error or an unreachable host is host_error, never an empty list', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error', detail: 'GitHub compare returned 502' });

    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error' });

    // A 200 with no files array is not "changed nothing".
    stubFetch(() => json({ status: 'ahead' }));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error' });
  });

  it('puts no token, no patch hunk and no host URL in the result', async () => {
    stubFetch(() => json(githubCompareBody()));
    const result = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ghs_changes_secret');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('secretHunk');
    expect(serialized).not.toContain('http');
  });
});

/** A GitLab `GET /api/v4/projects/:id/repository/compare` response, as the host
 *  sends it (trimmed). */
function gitlabCompareBody(diffs: unknown[] = gitlabThreeDiffs()) {
  return {
    commit: { id: HEAD_SHA, short_id: HEAD_SHA.slice(0, 8), title: 'feat: x' },
    commits: [{ id: '1111111111111111111111111111111111111111' }, { id: HEAD_SHA }],
    diffs,
    compare_timeout: false,
    compare_same_ref: false,
    web_url: `https://gitlab.com/acme/platform/web/-/compare/${BASE_SHA}...${HEAD_SHA}`,
  };
}

function gitlabThreeDiffs() {
  return [
    {
      old_path: 'src/new.ts',
      new_path: 'src/new.ts',
      a_mode: '0',
      b_mode: '100644',
      diff: '@@ -0,0 +1 @@\n+export const secretHunk = 1;',
      new_file: true,
      renamed_file: false,
      deleted_file: false,
    },
    {
      old_path: 'src/before.ts',
      new_path: 'src/after.ts',
      a_mode: '100644',
      b_mode: '100644',
      diff: '',
      new_file: false,
      renamed_file: true,
      deleted_file: false,
    },
    {
      old_path: 'src/gone.ts',
      new_path: 'src/gone.ts',
      a_mode: '100644',
      b_mode: '0',
      diff: '@@ -1 +0,0 @@\n-x',
      new_file: false,
      renamed_file: false,
      deleted_file: true,
    },
    {
      old_path: 'src/changed.ts',
      new_path: 'src/changed.ts',
      a_mode: '100644',
      b_mode: '100644',
      diff: '@@ -1 +1 @@\n-a\n+b',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
    },
  ];
}

describe('gitlab.listChangedFiles', () => {
  beforeEach(() => {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_changes_secret',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lists the paths from diffs[], with the same statuses GitHub would give', async () => {
    const fetchMock = stubFetch(() => json(gitlabCompareBody()));
    const result = await gitlab.listChangedFiles(
      'conn-1',
      'acme/platform',
      'web',
      'main',
      'feat/x',
    );
    expect(result).toEqual({
      outcome: 'ok',
      base: 'main',
      head: 'feat/x',
      files: [
        { path: 'src/new.ts', status: 'added' },
        { path: 'src/after.ts', status: 'renamed', previousPath: 'src/before.ts' },
        { path: 'src/gone.ts', status: 'removed' },
        { path: 'src/changed.ts', status: 'modified' },
      ],
      truncated: false,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/v4/projects/acme%2Fplatform%2Fweb/repository/compare');
    expect(url).toContain('?from=main&to=feat%2Fx');
  });

  it('holds GitLab to the SAME 300-file cap GitHub imposes', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        old_path: `f/${i}.ts`,
        new_path: `f/${i}.ts`,
        new_file: false,
        renamed_file: false,
        deleted_file: false,
      }));
    stubFetch(() => json(gitlabCompareBody(many(450))));
    const over = await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x');
    expect(over).toMatchObject({ outcome: 'ok', truncated: true });
    expect(over.outcome === 'ok' && over.files.length).toBe(300);

    stubFetch(() => json(gitlabCompareBody(many(12))));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'ok',
      truncated: false,
    });
  });

  it('a missing ref is no_such_ref; a project the token cannot see is revoked', async () => {
    stubFetch(() => json({ message: '404 Ref Not Found' }, 404));
    await expect(gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'nope')).resolves.toEqual(
      { outcome: 'no_such_ref', base: 'main', head: 'nope' },
    );

    stubFetch(() => json({ message: '404 Project Not Found' }, 404));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'revoked',
    });

    stubFetch(() => json({ message: '401 Unauthorized' }, 401));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'revoked',
    });
  });

  it('maps the token read’s failures to not_connected / revoked, without a host call', async () => {
    const fetchMock = stubFetch(() => json(gitlabCompareBody()));
    const spy = vi.spyOn(gitlabConnectionService, 'getAccessToken');

    spy.mockRejectedValueOnce(new GitlabTokenRefreshError('invalid_grant'));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toEqual({
      outcome: 'revoked',
      base: 'main',
      head: 'feat/x',
    });

    spy.mockRejectedValueOnce(new GitlabConnectionNotFoundError());
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'not_connected',
    });

    spy.mockRejectedValueOnce(new GitlabOAuthNotConfiguredError());
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'not_connected',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a compare GitLab gave up on is too_large, not a short list', async () => {
    stubFetch(() => json({ ...gitlabCompareBody(), compare_timeout: true }));
    await expect(
      gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x'),
    ).resolves.toEqual({ outcome: 'too_large', base: 'main', head: 'feat/x' });
  });

  it('a host that does not answer inside the deadline is host_error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x');
    await vi.advanceTimersByTimeAsync(CHANGED_FILES_TIMEOUT_MS);
    expect(await pending).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: `no response within ${CHANGED_FILES_TIMEOUT_MS}ms`,
    });
  });

  it('puts no token and no diff hunk in the result', async () => {
    stubFetch(() => json(gitlabCompareBody()));
    const result = await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('glpat_changes_secret');
    expect(serialized).not.toContain('secretHunk');
    expect(serialized).not.toContain('http');
  });
});

// ── Story gate MOTIR-6621 — the arms the feature suite above left uncovered ──
// The story's coverage floor, measured per function over each provider's
// `listChangedFiles` and its helpers: malformed host entries, a host that hangs
// or throws something odd, and SHAs a host did not give in the expected shape.
// Every one is still a NAMED result, never a throw.

describe('github.listChangedFiles — the residual arms (MOTIR-6621)', () => {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('skips files[] entries with no path; a SHA not in hex, or no commits list, degrades to null / the merge base', async () => {
    stubFetch(() =>
      json({
        base_commit: { sha: 'not-a-sha' },
        merge_base_commit: { sha: MERGE_BASE_SHA },
        // `commits` is absent altogether — head falls back to the merge base.
        files: [
          null,
          'lib/a-string.ts',
          { filename: '' },
          { status: 'added' },
          ...githubThreeFiles(),
        ],
      }),
    );
    expect(await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x')).toEqual({
      outcome: 'ok',
      base: 'main',
      head: 'feat/x',
      files: [
        { path: 'lib/new.ts', status: 'added' },
        { path: 'lib/changed.ts', status: 'modified' },
        { path: 'lib/after.ts', status: 'renamed', previousPath: 'lib/before.ts' },
      ],
      truncated: false,
      baseSha: null,
      headSha: MERGE_BASE_SHA,
    });
  });

  it('a token endpoint that answers 5xx is host_error with the mint’s own message, not revoked', async () => {
    const fetchMock = stubFetch(
      () => json(githubCompareBody()),
      () => json({ message: 'Server Error' }, 500),
    );
    const result = await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    expect(result).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: 'GitHub installation-token mint failed: token endpoint returned 500',
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/compare/'))).toBe(false);
  });

  it('a compare that does not answer inside the deadline is host_error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        String(url).includes('/access_tokens')
          ? Promise.resolve(tokenResponse())
          : new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
      ),
    );
    const pending = github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x');
    await vi.advanceTimersByTimeAsync(CHANGED_FILES_TIMEOUT_MS);
    expect(await pending).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: `no response within ${CHANGED_FILES_TIMEOUT_MS}ms`,
    });
  });

  it('a compare fetch that rejects with a non-Error is host_error "unknown"', async () => {
    stubFetch(() => Promise.reject('socket closed'));
    expect(await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x')).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: 'unknown',
    });
  });
});

describe('gitlab.listChangedFiles — the residual arms (MOTIR-6621)', () => {
  beforeEach(() => {
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_changes_secret',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips diffs[] entries with no usable path, and names a deletion by whichever path it has', async () => {
    stubFetch(() =>
      json({
        ...gitlabCompareBody([
          null,
          { new_path: 42, old_path: null, deleted_file: false },
          { new_path: '', old_path: '', deleted_file: true },
          { new_path: 'src/only-new.ts', old_path: '', deleted_file: true },
          { new_path: 'src/same.ts', old_path: 'src/same.ts', renamed_file: true },
          ...gitlabThreeDiffs(),
        ]),
      }),
    );
    const result = await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x');
    expect(result).toMatchObject({
      outcome: 'ok',
      files: [
        { path: 'src/only-new.ts', status: 'removed' },
        // A "rename" onto its own path is a modification, not a rename.
        { path: 'src/same.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'added' },
        { path: 'src/after.ts', status: 'renamed', previousPath: 'src/before.ts' },
        { path: 'src/gone.ts', status: 'removed' },
        { path: 'src/changed.ts', status: 'modified' },
      ],
    });
  });

  it('with no parseable web_url, head comes from commit.id — and a non-hex id is null', async () => {
    stubFetch(() => json({ ...gitlabCompareBody(), web_url: 'https://gitlab.com/acme/web' }));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'ok',
      baseSha: null,
      headSha: HEAD_SHA,
    });

    stubFetch(() =>
      json({ ...gitlabCompareBody(), web_url: undefined, commit: { id: 'not-a-sha' } }),
    );
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'ok',
      baseSha: null,
      headSha: null,
    });
  });

  it('a 5xx, a 200 with no diffs list, and a fetch that rejects are all host_error', async () => {
    stubFetch(() => new Response('bad gateway', { status: 502 }));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: 'GitLab compare returned 502',
    });

    stubFetch(() => json({ commit: { id: HEAD_SHA } }));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'host_error',
      detail: 'GitLab compare returned no diffs list',
    });

    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'host_error',
      detail: 'fetch failed',
    });

    stubFetch(() => Promise.reject('socket closed'));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'host_error',
      detail: 'unknown',
    });
  });

  it('a token read that fails for any OTHER reason is host_error, never a throw', async () => {
    const spy = vi.spyOn(gitlabConnectionService, 'getAccessToken');
    const fetchMock = stubFetch(() => json(gitlabCompareBody()));

    spy.mockRejectedValueOnce(new Error('decrypt failed'));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toEqual({
      outcome: 'host_error',
      base: 'main',
      head: 'feat/x',
      detail: 'decrypt failed',
    });

    spy.mockRejectedValueOnce('not an Error');
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'host_error',
      detail: 'the connection token could not be read',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A host answer whose BODY cannot be read — a 200 that is not JSON, and an error
// status whose body stream fails — is still a named result on both hosts.
describe('listChangedFiles — an unreadable host body (MOTIR-6621)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /** An error-status answer whose `text()` rejects, as a torn stream does. */
  function tornBody(status: number): Response {
    return {
      status,
      ok: false,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream torn')),
      json: () => Promise.reject(new Error('stream torn')),
    } as unknown as Response;
  }

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.spyOn(gitlabConnectionService, 'getAccessToken').mockResolvedValue({
      token: 'glpat_changes_secret',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('github: a non-JSON 200 and a torn error body are host_error', async () => {
    stubFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error', detail: 'GitHub compare returned no files list' });

    stubFetch(() => tornBody(502));
    expect(
      await github.listChangedFiles('inst-1', 'moooon', 'acme', 'main', 'feat/x'),
    ).toMatchObject({ outcome: 'host_error', detail: 'GitHub compare returned 502' });
  });

  it('gitlab: a non-JSON 200 is host_error; a torn 404 body is no_such_ref', async () => {
    stubFetch(() => new Response('<html>oops</html>', { status: 200 }));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toMatchObject({
      outcome: 'host_error',
      detail: 'GitLab compare returned no diffs list',
    });

    stubFetch(() => tornBody(404));
    expect(await gitlab.listChangedFiles('conn-1', 'acme', 'web', 'main', 'feat/x')).toEqual({
      outcome: 'no_such_ref',
      base: 'main',
      head: 'feat/x',
    });
  });
});
