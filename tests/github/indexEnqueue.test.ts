import { afterEach, describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { enqueueCodeGraphIndex, enqueueNewlyAddedRepos } from '@/lib/github/indexEnqueue';
import type { NormalizedRepo } from '@/lib/git/types';

// Story 7.10 · MOTIR-896 — the FEED-DISPATCH branches of the code-graph index
// enqueue (lib/github/indexEnqueue.ts) no per-subtask test reaches. The
// webhook-level test (githubWebhookService.test.ts, MOTIR-1500) proves the
// happy path through the service; these unit tests pin the chokepoint's own
// guarantees: the best-effort SWALLOW (a queue blip must never fail the caller
// — the PROD-443 rule the module header cites), the zero-new-repos → zero-sends
// reconcile, and one repo's failure never blocking its siblings.

const repo = (id: string, name: string): NormalizedRepo => ({
  providerRepoId: id,
  owner: 'moooon',
  name,
  defaultBranch: 'main',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enqueueCodeGraphIndex — best-effort (MOTIR-896)', () => {
  it('swallows + logs a transport failure — the caller NEVER sees the queue blip', async () => {
    const send = vi.spyOn(inngest, 'send').mockRejectedValue(new Error('queue down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      enqueueCodeGraphIndex({
        installationId: 'inst-1',
        workspaceId: 'ws-1',
        repoOwner: 'moooon',
        repoName: 'acme',
        defaultBranch: 'main',
      }),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
  });

  it('sends the job event with the exact payload', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueCodeGraphIndex({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
    });

    expect(send).toHaveBeenCalledWith({
      name: 'system.code-graph-index',
      data: {
        installationId: 'inst-1',
        workspaceId: 'ws-1',
        repoOwner: 'moooon',
        repoName: 'acme',
        defaultBranch: 'main',
      },
    });
  });
});

describe('enqueueNewlyAddedRepos — the reconcile filter (MOTIR-896)', () => {
  it('a re-selection that adds nothing enqueues NOTHING', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueNewlyAddedRepos({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core'), repo('2', 'ai')],
      existingRepoIds: ['1', '2'],
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('enqueues exactly the newly-added repos, skipping the already-present', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueNewlyAddedRepos({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core'), repo('2', 'ai'), repo('3', 'meta')],
      existingRepoIds: ['2'],
    });

    const names = send.mock.calls.map(
      (c) => (c[0] as { data: { repoName: string } }).data.repoName,
    );
    expect(names).toEqual(['core', 'meta']);
  });

  it('one repo’s enqueue failure never blocks the others (best-effort PER repo)', async () => {
    const send = vi
      .spyOn(inngest, 'send')
      .mockRejectedValueOnce(new Error('first blip'))
      .mockResolvedValue({ ids: [] } as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      enqueueNewlyAddedRepos({
        installationId: 'inst-1',
        workspaceId: 'ws-1',
        repos: [repo('1', 'core'), repo('2', 'ai')],
        existingRepoIds: [],
      }),
    ).resolves.toBeUndefined();

    // BOTH sends were attempted — the first failure was swallowed + logged.
    expect(send).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledOnce();
  });
});
