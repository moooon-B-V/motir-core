import { describe, expect, it } from 'vitest';
import { getGitProvider, registeredGitProviderIds, type GitProviderId } from '@/lib/git';

// Story 7.23 · MOTIR-1474 — the GitLab provider's PURE normalizers + its
// registration. No DB, no network: importing `@/lib/git` registers GitLab via its
// module side-effect. Mirrors the GitHub half in tests/git/providerSeam.test.ts,
// proving the SAME seam handles GitLab's merge-request / pipeline / push payloads.

const gitlab = getGitProvider('gitlab');

describe('gitlab provider registration', () => {
  it('is registered + resolvable under the "gitlab" id', () => {
    expect(registeredGitProviderIds()).toContain('gitlab');
    expect(getGitProvider('gitlab' as GitProviderId).id).toBe('gitlab');
  });
});

function mrEvent(overAttrs: Record<string, unknown> = {}): unknown {
  return {
    object_kind: 'merge_request',
    project: { id: 42 },
    object_attributes: {
      iid: 7,
      state: 'opened',
      merged: false,
      title: 'feat: a thing',
      source_branch: 'subtask/MOTIR-1474-gitlab',
      ...overAttrs,
    },
  };
}

describe('gitlab.parseChangeRequestEvent', () => {
  it('normalizes an opened merge_request payload', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent())).toEqual({
      providerRepoId: '42',
      number: 7,
      state: 'open',
      merged: false,
      headRef: 'subtask/MOTIR-1474-gitlab',
      title: 'feat: a thing',
    });
  });

  it('marks a merged MR closed + merged (GitLab "merged" is its own state)', () => {
    const cr = gitlab.parseChangeRequestEvent(mrEvent({ state: 'merged' }));
    expect(cr).toMatchObject({ state: 'closed', merged: true });
  });

  it('marks a closed-unmerged MR closed but not merged', () => {
    const cr = gitlab.parseChangeRequestEvent(mrEvent({ state: 'closed' }));
    expect(cr).toMatchObject({ state: 'closed', merged: false });
  });

  it('treats a locked MR as open', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent({ state: 'locked' }))).toMatchObject({
      state: 'open',
    });
  });

  it('returns null for a non-merge_request payload or a missing source branch', () => {
    expect(gitlab.parseChangeRequestEvent({ object_kind: 'push', project: { id: 1 } })).toBeNull();
    expect(gitlab.parseChangeRequestEvent(null)).toBeNull();
    expect(gitlab.parseChangeRequestEvent(mrEvent({ source_branch: undefined }))).toBeNull();
  });
});

describe('gitlab.changeRequestLifecycle', () => {
  const base = { providerRepoId: '1', number: 1, headRef: 'b', title: null } as const;

  it('maps open → in_review, merged → done, closed-unmerged → todo', () => {
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'open', merged: false })).toBe(
      'in_review',
    );
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: true })).toBe('done');
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: false })).toBe('todo');
  });
});

describe('gitlab.parseCiStatusEvent', () => {
  function pipeline(status: string, extra: Record<string, unknown> = {}): unknown {
    return {
      object_kind: 'pipeline',
      project: { id: 9 },
      object_attributes: { id: 100, sha: 'abc123', ref: 'feat/x', status },
      ...extra,
    };
  }

  it('normalizes a successful pipeline with the associated MR iid + branch', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('success', { merge_request: { iid: 7 } }))).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'success',
      context: 'pipeline',
      prNumbers: [7],
      headBranch: 'feat/x',
    });
  });

  it('maps failed → failure, running → pending, skipped → neutral', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('failed'))).toMatchObject({ conclusion: 'failure' });
    expect(gitlab.parseCiStatusEvent(pipeline('running'))).toMatchObject({ conclusion: 'pending' });
    expect(gitlab.parseCiStatusEvent(pipeline('skipped'))).toMatchObject({ conclusion: 'neutral' });
  });

  it('has empty prNumbers when the pipeline carries no merge_request', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('success'))).toMatchObject({ prNumbers: [] });
  });

  it('returns null for a non-pipeline payload or a missing project id', () => {
    expect(gitlab.parseCiStatusEvent({ object_kind: 'push', project: { id: 9 } })).toBeNull();
    expect(
      gitlab.parseCiStatusEvent({
        object_kind: 'pipeline',
        object_attributes: { sha: 'x', status: 'success' },
      }),
    ).toBeNull();
  });
});

describe('gitlab.parsePushEvent', () => {
  const SHA = 'f'.repeat(40);

  it('normalizes a branch push (short branch name + head sha)', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/main',
        after: SHA,
        project: { id: 42 },
      }),
    ).toEqual({ providerRepoId: '42', branch: 'main', headSha: SHA });
  });

  it('keeps a slashed branch name intact', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/subtask/MOTIR-1476-feed',
        after: SHA,
        project: { id: 42 },
      }),
    ).toMatchObject({ branch: 'subtask/MOTIR-1476-feed' });
  });

  it('returns null for a tag push, a branch deletion, and a missing project', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'tag_push',
        ref: 'refs/tags/v1',
        after: SHA,
        project: { id: 42 },
      }),
    ).toBeNull();
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/main',
        after: '0'.repeat(40),
        project: { id: 42 },
      }),
    ).toBeNull();
    expect(
      gitlab.parsePushEvent({ object_kind: 'push', ref: 'refs/heads/main', after: SHA }),
    ).toBeNull();
  });
});
