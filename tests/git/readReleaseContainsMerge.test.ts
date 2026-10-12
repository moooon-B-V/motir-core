import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';

// WHETHER A RELEASE CARRIES A PULL REQUEST'S MERGE (Bug MOTIR-8330), through the
// REAL GitHub provider against an undici `MockAgent` with net connect disabled —
// so the two calls it makes, and what it reads off each, are what is asserted.

const github = getGitProvider('github') as Required<GitProvider>;
const original = getGlobalDispatcher();
const MERGE = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);

let agent: MockAgent;

function host(
  pull: { status: number; body?: unknown },
  compare?: { status: number; body?: unknown },
) {
  agent = new MockAgent();
  agent.disableNetConnect();
  const api = agent.get('https://api.github.com');
  api
    .intercept({ path: '/repos/acme/web/pulls/42', method: 'GET' })
    .reply(pull.status, pull.body ?? {});
  if (compare) {
    api
      .intercept({ path: `/repos/acme/web/compare/${MERGE}...${RELEASE}`, method: 'GET' })
      .reply(compare.status, compare.body ?? {});
  }
  setGlobalDispatcher(agent);
}

const ask = () =>
  github.readReleaseContainsMerge({
    installationId: 'inst-1',
    owner: 'acme',
    name: 'web',
    number: 42,
    release: RELEASE,
  });

const merged = { status: 200, body: { merged: true, merge_commit_sha: MERGE } };

afterEach(async () => {
  await agent?.close();
});

afterAll(() => {
  setGlobalDispatcher(original);
});

describe('readReleaseContainsMerge reads the compare STATUS from the merge to the release', () => {
  it.each([
    ['ahead', 'contains'],
    ['identical', 'contains'],
    ['behind', 'missing'],
    ['diverged', 'missing'],
    ['something-new', 'unknown'],
  ] as const)('compare status %s → %s', async (status, expected) => {
    host(merged, { status: 200, body: { status } });
    expect(await ask()).toBe(expected);
  });

  it('a release the host does not know (404) is unknown', async () => {
    host(merged, { status: 404, body: { message: 'Not Found' } });
    expect(await ask()).toBe('unknown');
  });

  it('a pull request that did not merge is unknown, and the compare is never asked', async () => {
    host({ status: 200, body: { merged: false, merge_commit_sha: MERGE } });
    expect(await ask()).toBe('unknown');
  });

  it('a refused pull-request read is unknown', async () => {
    host({ status: 403, body: { message: 'Forbidden' } });
    expect(await ask()).toBe('unknown');
  });

  it('an unreachable host is unknown, never a throw', async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/acme/web/pulls/42', method: 'GET' })
      .replyWithError(new Error('socket hang up'));
    setGlobalDispatcher(agent);
    expect(await ask()).toBe('unknown');
  });
});
