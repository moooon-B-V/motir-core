import { describe, expect, it } from 'vitest';
import {
  getGitProvider,
  registeredGitProviderIds,
  UnknownGitProviderError,
  type GitProviderId,
} from '@/lib/git';

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
