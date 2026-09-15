import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import {
  installGithubMergeMock,
  mergeMockNodeId,
  type GithubMergeCall,
  type GithubMergeControl,
} from '@/lib/test-github-merge-mock';
import { installGithubReposMock } from '@/lib/test-github-repos-mock';

// THE E2E GITHUB MERGE SEAM (Story MOTIR-4909 · MOTIR-5572), driven through the REAL
// `mergeChangeRequest` — the provider the approve-and-merge press calls — against the seam's
// intercepts on an undici `MockAgent` installed as the global dispatcher, exactly as
// instrumentation.ts installs it in the E2E server. Net connect is DISABLED here, so any call
// the seam does not answer fails loudly instead of reaching api.github.com.

const github = getGitProvider('github') as Required<GitProvider>;
const original = getGlobalDispatcher();
const dir = mkdtempSync(join(tmpdir(), 'github-merge-mock-'));
const CONTROL = join(dir, 'control.json');
const JOURNAL = join(dir, 'journal.jsonl');

let agent: MockAgent;

function control(value: GithubMergeControl) {
  writeFileSync(CONTROL, JSON.stringify(value));
}

function journal(): GithubMergeCall[] {
  try {
    return readFileSync(JOURNAL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GithubMergeCall);
  } catch {
    return [];
  }
}

const merge = (owner: string, name: string, number: number, expectedHeadSha = 'head-1') =>
  github.mergeChangeRequest({ installationId: 'inst-1', owner, name, number, expectedHeadSha });

function installAgent(install: (agent: MockAgent) => void) {
  agent = new MockAgent();
  agent.disableNetConnect();
  install(agent);
  setGlobalDispatcher(agent);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('MOTIR_GITHUB_MERGE_CONTROL_PATH', CONTROL);
  vi.stubEnv('MOTIR_GITHUB_MERGE_JOURNAL_PATH', JOURNAL);
  vi.stubEnv('E2E_TEST_GITHUB_REPOS', '');
  writeFileSync(JOURNAL, '');
  control({});
  installAgent(installGithubMergeMock);
});

afterAll(async () => {
  setGlobalDispatcher(original);
  vi.unstubAllEnvs();
});

describe('merged, enqueued and refused — through the real mergeChangeRequest', () => {
  it('a listed repository with no entry MERGES, and the journal shows the merge call', async () => {
    control({ repositories: ['acme/web'] });

    expect(await merge('acme', 'web', 7)).toEqual({ outcome: 'merged', commitSha: 'e2e-merge-7' });

    const puts = journal().filter((c) => c.method === 'PUT');
    expect(puts).toEqual([
      expect.objectContaining({ path: '/repos/acme/web/pulls/7/merge', pullRequest: 'acme/web#7' }),
    ]);
    expect(puts[0]!.body).toMatchObject({ sha: 'head-1', merge_method: 'squash' });
  });

  it('`enqueued` returns the mock’s queue entry through the GraphQL enqueue', async () => {
    control({ pullRequests: { 'acme/api#12': { outcome: 'enqueued' } } });

    expect(await merge('acme', 'api', 12)).toEqual({ outcome: 'enqueued', entryId: 'MQE_e2e_12' });

    const graphql = journal().filter((c) => c.path === '/graphql');
    expect(graphql).toEqual([
      expect.objectContaining({ method: 'POST', pullRequest: 'acme/api#12' }),
    ]);
    expect(JSON.stringify(graphql[0]!.body)).toContain(mergeMockNodeId('acme/api#12'));
  });

  it('a repository whose base REQUIRES a merge queue enqueues from the rules read, with no merge call', async () => {
    control({ repositories: ['acme/api'], mergeQueueRepositories: ['acme/api'] });

    expect(await merge('acme', 'api', 3)).toEqual({ outcome: 'enqueued', entryId: 'MQE_e2e_3' });
    expect(journal().some((c) => c.method === 'PUT')).toBe(false);
  });

  it.each([
    [
      'checks_not_green',
      { code: 'checks_not_green', reason: 'Required status check "ci" is expected.' },
    ],
    ['conflict', { code: 'conflict' }],
    [
      'branch_protected',
      {
        code: 'branch_protected',
        reason: 'At least 1 approving review is required by reviewers with write access.',
      },
    ],
    ['already_merged', { code: 'already_merged' }],
    ['app_permission_missing', { code: 'app_permission_missing', permission: 'contents: write' }],
    ['subject_changed', { code: 'subject_changed' }],
  ] as const)('a `%s` refusal is classified as that typed refusal', async (refusal, expected) => {
    control({ pullRequests: { 'acme/web#7': { outcome: 'refused', refusal } } });

    expect(await merge('acme', 'web', 7)).toEqual({ outcome: 'refused', refusal: expected });
  });

  it('a head the control reports that the approval did not see is a subject that changed', async () => {
    control({ pullRequests: { 'acme/web#7': { outcome: 'merged', headSha: 'head-moved' } } });

    expect(await merge('acme', 'web', 7, 'head-1')).toEqual({
      outcome: 'refused',
      refusal: { code: 'subject_changed' },
    });
  });

  it('is steerable mid-test: a refused press, then the control changes, and the retry merges', async () => {
    control({ pullRequests: { 'acme/web#7': { outcome: 'refused', refusal: 'conflict' } } });
    expect(await merge('acme', 'web', 7)).toMatchObject({ outcome: 'refused' });

    control({ pullRequests: { 'acme/web#7': { outcome: 'merged' } } });
    expect(await merge('acme', 'web', 7)).toEqual({ outcome: 'merged', commitSha: 'e2e-merge-7' });
  });

  it('answers NOTHING for a repository the control does not name — the call is not this seam’s', async () => {
    control({ repositories: ['acme/web'] });

    await expect(merge('someone', 'else', 1)).rejects.toMatchObject({
      name: 'MergeChangeRequestError',
      reason: 'unreachable',
    });
    expect(journal()).toEqual([]);
  });

  it('with no control file at all, and no journal path, it answers nothing and throws nothing', async () => {
    vi.stubEnv('MOTIR_GITHUB_MERGE_CONTROL_PATH', '');
    vi.stubEnv('MOTIR_GITHUB_MERGE_JOURNAL_PATH', '');

    await expect(merge('acme', 'web', 7)).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('a half-written control file is read as naming no repository', async () => {
    writeFileSync(CONTROL, '{"repositories": ["acme/w');

    await expect(merge('acme', 'web', 7)).rejects.toMatchObject({ reason: 'unreachable' });
  });
});

describe('the installation token', () => {
  it('is answered here when the repos seam is off', async () => {
    const res = await fetch('https://api.github.com/app/installations/42/access_tokens', {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ token: 'ghs_e2e_merge_token' });
    expect(journal()).toEqual([
      expect.objectContaining({ method: 'POST', path: '/app/installations/42/access_tokens' }),
    ]);
  });

  it('is LEFT to the repos seam when it is on, so its journal keeps the line', async () => {
    vi.stubEnv('E2E_TEST_GITHUB_REPOS', '1');
    installAgent(installGithubMergeMock);

    await expect(
      fetch('https://api.github.com/app/installations/42/access_tokens', { method: 'POST' }),
    ).rejects.toThrow();
    expect(journal()).toEqual([]);
  });
});

describe('coexistence with E2E_TEST_GITHUB_REPOS on one agent, in instrumentation’s order', () => {
  it('a merge repository read and a provisioning readiness read each get their own seam’s answer', async () => {
    const reposJournal = join(dir, 'repos-journal.jsonl');
    writeFileSync(reposJournal, '');
    vi.stubEnv('E2E_TEST_GITHUB_REPOS', '1');
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-e2e');
    vi.stubEnv('MOTIR_GITHUB_CONTROL_PATH', join(dir, 'repos-control.json'));
    vi.stubEnv('MOTIR_GITHUB_JOURNAL_PATH', reposJournal);
    installAgent((a) => {
      installGithubMergeMock(a);
      installGithubReposMock(a);
    });
    control({ repositories: ['motir-e2e/web'] });

    // The merge seam claims ITS repository, in the provisioning org the repos seam also serves.
    expect(await merge('motir-e2e', 'web', 9)).toEqual({
      outcome: 'merged',
      commitSha: 'e2e-merge-9',
    });

    // A repository the merge control does not name falls through to the repos seam's
    // readiness read — which has created nothing, so it answers 404.
    const readiness = await fetch('https://api.github.com/repos/motir-e2e/not-created');
    expect(readiness.status).toBe(404);
    expect(readFileSync(reposJournal, 'utf8')).toContain('/repos/motir-e2e/not-created');
    expect(journal().some((c) => c.path === '/repos/motir-e2e/not-created')).toBe(false);

    // And the token mint is the repos seam's, journaled there.
    const token = await fetch('https://api.github.com/app/installations/7/access_tokens', {
      method: 'POST',
    });
    expect(token.status).toBe(200);
    expect(readFileSync(reposJournal, 'utf8')).toContain('/app/installations/7/access_tokens');
  });
});

describe('the answers the provider short-circuits before the merge call', () => {
  // `mergeChangeRequest` returns on the pull request read for an already-merged or closed pull
  // request, so these two merge-call answers are reachable only by a caller that skips the read.
  it.each([
    ['already_merged', 405, 'Pull Request is not mergeable'],
    ['subject_changed', 409, 'Head branch was modified. Review and try the merge again.'],
  ] as const)('a direct merge call for `%s` answers %i', async (refusal, status, message) => {
    control({ pullRequests: { 'acme/web#7': { outcome: 'refused', refusal } } });

    const res = await fetch('https://api.github.com/repos/acme/web/pulls/7/merge', {
      method: 'PUT',
      body: JSON.stringify({ sha: 'head-1' }),
    });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ message });
  });

  it('an enqueue whose node id carries no pull request still answers, naming none', async () => {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      body: '{"variables":{"pullRequestId":"E2E_MERGE_PR_"}}',
    });

    expect(await res.json()).toEqual({
      data: { enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_e2e_0' } } },
    });
    expect(journal()).toEqual([expect.objectContaining({ path: '/graphql', pullRequest: null })]);
  });

  it('a merge call with no body journals a null body', async () => {
    control({ repositories: ['acme/web'] });

    await fetch('https://api.github.com/repos/acme/web/pulls/8/merge', { method: 'PUT' });

    expect(journal()).toEqual([expect.objectContaining({ body: null, pullRequest: 'acme/web#8' })]);
  });
});
