import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client + the project resolver (no network, no DB).
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey: vi.fn() } }));

import { aiJobsService } from '@/lib/services/aiJobsService';
import { projectsService } from '@/lib/services/projectsService';
import { submitJob, getJob } from '@/lib/ai/motirAiClient';
import type { WorkspaceContext } from '@/lib/workspaces/context';

const ctx: WorkspaceContext = { userId: 'user_1', workspaceId: 'ws_1' };

beforeEach(() => vi.clearAllMocks());

describe('aiJobsService.submitNoopJob', () => {
  it('resolves the project and submits a noop with the right tenant + actor', async () => {
    vi.mocked(projectsService.getByKey).mockResolvedValue({
      id: 'pj_1',
      identifier: 'MOTIR',
      name: 'Motir',
    } as Awaited<ReturnType<typeof projectsService.getByKey>>);
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiJobsService.submitNoopJob('MOTIR', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    expect(projectsService.getByKey).toHaveBeenCalledWith('MOTIR', ctx);
    expect(submitJob).toHaveBeenCalledWith(
      'noop',
      { workspaceId: 'ws_1', projectId: 'pj_1', projectKey: 'MOTIR' },
      {},
      { userId: 'user_1' },
    );
  });
});

describe('aiJobsService.getJobStatus', () => {
  it('delegates to the client', async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'j',
      status: 'succeeded',
      result: null,
      error: null,
    });
    const view = await aiJobsService.getJobStatus('j');
    expect(view.status).toBe('succeeded');
    expect(getJob).toHaveBeenCalledWith('j');
  });
});
