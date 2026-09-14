import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { mintInstallationToken } from '@/lib/github/appAuth';
import { getGitProvider } from '@/lib/git';
import { MERGE_CHANGE_REQUEST_TIMEOUT_MS, providerSupportsMerge } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { MergeChangeRequestInput } from '@/lib/git/types';

// `GitProvider.mergeChangeRequest` — THE MERGE SEAM (Story MOTIR-4882 · MOTIR-5514;
// `approval-gates.md` §4 second amendment, decisions 5, 7 and 8). No database: the
// host is `fetch`, stubbed per case, and the App credential is `appAuth`, mocked.
//
// The matrix is the point. GitHub answers the SAME 405 for a conflict, a missing
// review, failing checks and an already-merged pull request, and a person needs to
// be told which — so each answer is driven and its normalized refusal asserted.

const github = getGitProvider('github');
const gitlab = getGitProvider('gitlab');

const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';

const INPUT: MergeChangeRequestInput = {
  installationId: 'inst-1',
  owner: 'acme',
  name: 'web',
  number: 7,
  expectedHeadSha: HEAD,
};

const ALL_METHODS = {
  allow_squash_merge: true,
  allow_merge_commit: true,
  allow_rebase_merge: true,
};

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A pull request as GitHub reads it back — the node id the queue addresses and its base. */
const OPEN_PULL: Route = {
  status: 200,
  body: {
    node_id: 'PR_kwDO_7',
    merged: false,
    state: 'open',
    head: { sha: HEAD },
    base: { ref: 'main' },
  },
};

/** A base branch with no active rules — the ordinary, queue-less repository. */
const NO_RULES: Route = { status: 200, body: [] };

/** The GraphQL answer to a successful enqueue. */
const ENQUEUED = (id: string): Route => ({
  status: 200,
  body: { data: { enqueuePullRequest: { mergeQueueEntry: { id } } } },
});

/**
 * Route every call a merge makes: the repository read, the pull request read(s), the
 * base branch's rules, the merge, and the GraphQL queue calls (answered IN ORDER). The
 * pull request and rules default to an open, queue-less one, so a case that is not
 * about them need not say so.
 */
function stubHost(routes: {
  repo?: Route;
  merge?: Route;
  pull?: Route;
  rules?: Route;
  graphql?: Route[];
}): Call[] {
  const calls: Call[] = [];
  const graphql = [...(routes.graphql ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({
        url: u,
        method,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      const route = u.endsWith('/graphql')
        ? graphql.shift()
        : method === 'PUT'
          ? routes.merge
          : /\/rules\/branches\//.test(u)
            ? (routes.rules ?? NO_RULES)
            : /\/pulls\/\d+$/.test(u)
              ? (routes.pull ?? OPEN_PULL)
              : routes.repo;
      if (!route) throw new Error(`unrouted ${method} ${u}`);
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.mocked(mintInstallationToken).mockClear();
});

describe('the capability is declared by the method, and asked by one predicate', () => {
  it('GitHub merges; GitLab does not implement it (MOTIR-4883 does)', () => {
    expect(providerSupportsMerge(github)).toBe(true);
    expect(providerSupportsMerge(gitlab)).toBe(false);
  });
});

describe('every GitHub answer normalizes to merged or a typed refusal', () => {
  const openPull = (over: Record<string, unknown>) => ({
    status: 200,
    body: { merged: false, state: 'open', head: { sha: HEAD }, ...over },
  });

  const CASES: Array<{ name: string; routes: Parameters<typeof stubHost>[0]; expected: unknown }> =
    [
      {
        name: '200 with merged: true → merged, carrying the merge commit',
        routes: { merge: { status: 200, body: { merged: true, sha: 'f00dfeedcafe' } } },
        expected: { outcome: 'merged', commitSha: 'f00dfeedcafe' },
      },
      {
        name: '405 with mergeable_state dirty → conflict',
        routes: {
          merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
          pull: openPull({ mergeable_state: 'dirty' }),
        },
        expected: { outcome: 'refused', refusal: { code: 'conflict' } },
      },
      {
        name: '405 blocked by a required review → branch_protected, carrying the host reason',
        routes: {
          merge: {
            status: 405,
            body: {
              message: 'At least 1 approving review is required by reviewers with write access.',
            },
          },
          pull: openPull({ mergeable_state: 'blocked' }),
        },
        expected: {
          outcome: 'refused',
          refusal: {
            code: 'branch_protected',
            reason: 'At least 1 approving review is required by reviewers with write access.',
          },
        },
      },
      {
        name: '405 blocked by a failing required check → checks_not_green',
        routes: {
          merge: {
            status: 405,
            body: { message: 'Required status check "ci / vitest" is expected.' },
          },
          pull: openPull({ mergeable_state: 'blocked' }),
        },
        expected: {
          outcome: 'refused',
          refusal: {
            code: 'checks_not_green',
            reason: 'Required status check "ci / vitest" is expected.',
          },
        },
      },
      {
        name: '405 on a pull request that already merged → already_merged',
        routes: {
          merge: { status: 405, body: { message: 'Pull Request is not mergeable' } },
          pull: { status: 200, body: { merged: true, state: 'closed', head: { sha: HEAD } } },
        },
        expected: { outcome: 'refused', refusal: { code: 'already_merged' } },
      },
      {
        name: '409 — the head moved → subject_changed',
        routes: { merge: { status: 409, body: { message: 'Head branch was modified.' } } },
        expected: { outcome: 'refused', refusal: { code: 'subject_changed' } },
      },
      {
        name: '404 → subject_changed',
        routes: { merge: { status: 404, body: { message: 'Not Found' } } },
        expected: { outcome: 'refused', refusal: { code: 'subject_changed' } },
      },
      {
        name: '403 → app_permission_missing, naming the permission the host asked for',
        routes: {
          merge: {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
            headers: { 'x-accepted-github-permissions': 'contents=write' },
          },
        },
        expected: {
          outcome: 'refused',
          refusal: { code: 'app_permission_missing', permission: 'contents: write' },
        },
      },
      {
        name: '403 with no permission header still names what a merge needs',
        routes: {
          merge: { status: 403, body: { message: 'Resource not accessible by integration' } },
        },
        expected: {
          outcome: 'refused',
          refusal: { code: 'app_permission_missing', permission: 'contents: write' },
        },
      },
      {
        name: 'the queue-required 405 → ENQUEUED onto the merge queue instead (MOTIR-5516)',
        routes: {
          merge: { status: 405, body: { message: 'Changes must be made through the merge queue' } },
          graphql: [ENQUEUED('MQE_1')],
        },
        expected: { outcome: 'enqueued', entryId: 'MQE_1' },
      },
    ];

  it.each(CASES)('$name', async ({ routes, expected }) => {
    stubHost({ repo: { status: 200, body: ALL_METHODS }, ...routes });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual(expected);
  });

  it('the queue-required 405 is followed by exactly ONE enqueue, carrying the node id and the head', async () => {
    const calls = stubHost({
      repo: { status: 200, body: ALL_METHODS },
      merge: { status: 405, body: { message: 'Changes must be made through the merge queue' } },
      graphql: [ENQUEUED('MQE_1')],
    });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'enqueued',
      entryId: 'MQE_1',
    });
    const enqueues = calls.filter((c) => c.url.endsWith('/graphql'));
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]?.body?.['variables']).toEqual({
      pullRequestId: 'PR_kwDO_7',
      expectedHeadOid: HEAD,
    });
  });
});

describe('the request carries the head it was decided on, and a method the repository allows', () => {
  it('sends sha: expectedHeadSha, and takes squash when the repository allows it', async () => {
    const calls = stubHost({
      repo: { status: 200, body: ALL_METHODS },
      merge: { status: 200, body: { merged: true, sha: 'abc' } },
    });
    await github.mergeChangeRequest!(INPUT);

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('https://api.github.com/repos/acme/web/pulls/7/merge');
    expect(put?.body).toEqual({ sha: HEAD, merge_method: 'squash' });
  });

  it('takes REBASE when that is the only method the repository allows — never a hard-coded one', async () => {
    const calls = stubHost({
      repo: {
        status: 200,
        body: { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true },
      },
      merge: { status: 200, body: { merged: true, sha: 'abc' } },
    });
    await github.mergeChangeRequest!(INPUT);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      sha: HEAD,
      merge_method: 'rebase',
    });
  });

  it('omits merge_method when the repository names none, leaving the host its own default', async () => {
    const calls = stubHost({
      repo: { status: 200, body: { full_name: 'acme/web' } },
      merge: { status: 200, body: { merged: true, sha: 'abc' } },
    });
    await github.mergeChangeRequest!(INPUT);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ sha: HEAD });
  });
});

describe('the App is chosen by the repository PROVENANCE', () => {
  it('a HOSTED repository mints through provisioning; an IMPORTED one through user-facing', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      merge: { status: 200, body: { merged: true, sha: 'abc' } },
    });

    await github.mergeChangeRequest!({ ...INPUT, owner: 'motir-projects' });
    expect(mintInstallationToken).toHaveBeenLastCalledWith('inst-1', 'provisioning');

    await github.mergeChangeRequest!({ ...INPUT, owner: 'acme' });
    expect(mintInstallationToken).toHaveBeenLastCalledWith('inst-1', 'user-facing');
  });
});

describe('a host that does not answer is an ERROR, never a refusal', () => {
  it('throws MergeChangeRequestError after the timeout and returns no refusal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );

    const pending = github.mergeChangeRequest!(INPUT);
    const assertion = expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof MergeChangeRequestError && err.reason === 'timeout',
    );
    await vi.advanceTimersByTimeAsync(MERGE_CHANGE_REQUEST_TIMEOUT_MS + 1);
    await assertion;
  });

  it('a status no refusal names is an error too', async () => {
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      merge: { status: 502, body: { message: 'Bad Gateway' } },
    });
    await expect(github.mergeChangeRequest!(INPUT)).rejects.toBeInstanceOf(MergeChangeRequestError);
  });
});

describe('a base branch that REQUIRES a merge queue is enqueued, never merged (MOTIR-5516)', () => {
  const QUEUE_RULES: Route = {
    status: 200,
    body: [{ type: 'pull_request' }, { type: 'merge_queue', parameters: {} }],
  };

  const queueError = (type: string, message: string, headers?: Record<string, string>): Route => ({
    status: 200,
    headers,
    body: { data: { enqueuePullRequest: null }, errors: [{ type, message }] },
  });

  it('reads the base branch rules, makes NO merge call, and ONE enqueue carrying the node id and head', async () => {
    const calls = stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [ENQUEUED('MQE_9')],
    });

    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'enqueued',
      entryId: 'MQE_9',
    });

    expect(
      calls.some((c) => c.url === 'https://api.github.com/repos/acme/web/rules/branches/main'),
    ).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    const enqueues = calls.filter((c) => c.url.endsWith('/graphql'));
    expect(enqueues).toHaveLength(1);
    expect(String(enqueues[0]?.body?.['query'])).toContain('enqueuePullRequest');
    expect(enqueues[0]?.body?.['variables']).toEqual({
      pullRequestId: 'PR_kwDO_7',
      expectedHeadOid: HEAD,
    });
  });

  it('an ALREADY-QUEUED pull request answers enqueued with the EXISTING entry — never a refusal', async () => {
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [
        queueError('UNPROCESSABLE', 'Pull request is already in the merge queue'),
        { status: 200, body: { data: { node: { mergeQueueEntry: { id: 'MQE_existing' } } } } },
      ],
    });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'enqueued',
      entryId: 'MQE_existing',
    });
  });

  it('a head that no longer matches expectedHeadOid → subject_changed', async () => {
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [
        queueError(
          'UNPROCESSABLE',
          'Expected head oid does not match the head of the pull request',
        ),
      ],
    });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'refused',
      refusal: { code: 'subject_changed' },
    });
  });

  it('unsatisfied checks → checks_not_green', async () => {
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [queueError('UNPROCESSABLE', 'Required status checks have not succeeded')],
    });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'refused',
      refusal: { code: 'checks_not_green', reason: 'Required status checks have not succeeded' },
    });
  });

  it('FORBIDDEN names the permission GitHub asked for, rather than guessing one', async () => {
    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [
        queueError('FORBIDDEN', 'Resource not accessible by integration', {
          'x-accepted-github-permissions': 'pull_requests=write',
        }),
      ],
    });
    await expect(github.mergeChangeRequest!(INPUT)).resolves.toEqual({
      outcome: 'refused',
      refusal: { code: 'app_permission_missing', permission: 'pull_requests: write' },
    });
  });

  it('the rules read and the enqueue mint ONE token, through the provenance role', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');

    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [ENQUEUED('MQE_1')],
    });
    await github.mergeChangeRequest!({ ...INPUT, owner: 'motir-projects' });
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(mintInstallationToken).toHaveBeenLastCalledWith('inst-1', 'provisioning');

    stubHost({
      repo: { status: 200, body: ALL_METHODS },
      rules: QUEUE_RULES,
      graphql: [ENQUEUED('MQE_2')],
    });
    await github.mergeChangeRequest!({ ...INPUT, owner: 'acme' });
    expect(mintInstallationToken).toHaveBeenCalledTimes(2);
    expect(mintInstallationToken).toHaveBeenLastCalledWith('inst-1', 'user-facing');
  });
});
