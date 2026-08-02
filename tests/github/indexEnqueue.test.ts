import { afterEach, describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { enqueueCodeGraphIndex, enqueueReposMissingFirstIndex } from '@/lib/github/indexEnqueue';
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
  archived: false,
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

describe('enqueueReposMissingFirstIndex — the reconcile filter (MOTIR-896 · MOTIR-1961)', () => {
  it('a reconcile whose repos are ALL indexed enqueues NOTHING', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueReposMissingFirstIndex({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core'), repo('2', 'ai')],
      indexedRepoRefs: ['moooon/core', 'moooon/ai'],
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('enqueues exactly the repos with NO code graph, skipping the already-indexed', async () => {
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueReposMissingFirstIndex({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core'), repo('2', 'ai'), repo('3', 'meta')],
      indexedRepoRefs: ['moooon/ai'],
    });

    const names = send.mock.calls.map(
      (c) => (c[0] as { data: { repoName: string } }).data.repoName,
    );
    expect(names).toEqual(['core', 'meta']);
  });

  it('the REGRESSION: a long-present repo that was never indexed still enqueues (MOTIR-1961)', async () => {
    // The state the old novelty gate could not escape — every repo row already
    // exists (nothing is "newly added"), and not one has a graph. Under the old
    // `existingRepoIds` gate this enqueued zero jobs, forever.
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueReposMissingFirstIndex({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core'), repo('2', 'ai'), repo('3', 'meta')],
      indexedRepoRefs: [],
    });

    const names = send.mock.calls.map(
      (c) => (c[0] as { data: { repoName: string } }).data.repoName,
    );
    expect(names).toEqual(['core', 'ai', 'meta']);
  });

  it('matches the indexed set on owner/name, not on name alone', async () => {
    // Two owners can select repos of the same name; only the exact ref counts.
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    await enqueueReposMissingFirstIndex({
      installationId: 'inst-1',
      workspaceId: 'ws-1',
      repos: [repo('1', 'core')],
      indexedRepoRefs: ['someone-else/core'],
    });

    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0]![0] as { data: { repoName: string } }).data.repoName).toBe('core');
  });

  it('one repo’s enqueue failure never blocks the others (best-effort PER repo)', async () => {
    const send = vi
      .spyOn(inngest, 'send')
      .mockRejectedValueOnce(new Error('first blip'))
      .mockResolvedValue({ ids: [] } as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      enqueueReposMissingFirstIndex({
        installationId: 'inst-1',
        workspaceId: 'ws-1',
        repos: [repo('1', 'core'), repo('2', 'ai')],
        indexedRepoRefs: [],
      }),
    ).resolves.toBeUndefined();

    // BOTH sends were attempted — the first failure was swallowed + logged.
    expect(send).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledOnce();
  });
});
