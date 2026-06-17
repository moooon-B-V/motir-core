import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network). The chat service receives an
// already-resolved ProjectContext, so there is no project resolver to mock.
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), streamJob: vi.fn() }));

import { aiChatService } from '@/lib/services/aiChatService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
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
  it('submits a discovery job with the tenant + prompt + actor from the context', async () => {
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiChatService.submitDiscoveryTurn('build me a tracker', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'discovery',
      { workspaceId: 'ws_1', projectId: 'pj_1', projectKey: 'MOTIR' },
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
