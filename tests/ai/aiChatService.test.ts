import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network). The chat service receives an
// already-resolved ProjectContext, so there is no project resolver to mock — the
// only extra read is the workspace ORG (7.2.16): withWorkspaceContext is stubbed
// to invoke its callback with a fake tx so the org read is a plain mocked repo
// call (same shape as aiJobsService.test).
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), streamJob: vi.fn() }));
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: vi.fn() },
}));
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import { aiChatService } from '@/lib/services/aiChatService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

beforeEach(() => vi.clearAllMocks());

describe('aiChatService.submitDiscoveryTurn', () => {
  it('resolves the workspace org and submits a discovery job with the tenant + prompt + actor', async () => {
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue({
      organizationId: 'org_1',
    } as Awaited<ReturnType<typeof workspaceRepository.findByIdInTx>>);
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiChatService.submitDiscoveryTurn('build me a tracker', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    expect(workspaceRepository.findByIdInTx).toHaveBeenCalledWith('ws_1', expect.anything());
    expect(submitJob).toHaveBeenCalledWith(
      'discovery',
      { organizationId: 'org_1', workspaceId: 'ws_1', projectId: 'pj_1', projectKey: 'MOTIR' },
      { prompt: 'build me a tracker' },
      { userId: 'user_1' },
    );
  });
});

describe('aiChatService.streamDiscovery', () => {
  it('relays the client job stream frames for the given jobId', async () => {
    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'done', data: { status: 'succeeded' } },
    ];
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiChatService.streamDiscovery('job_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1');
    expect(got).toEqual(frames);
  });
});
