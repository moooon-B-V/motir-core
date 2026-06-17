import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client + the project resolver + the org resolution (no
// network, no DB). withWorkspaceContext is stubbed to invoke its callback with a
// fake tx so the org read is a plain mocked repository call.
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey: vi.fn() } }));
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: vi.fn() },
}));
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import { aiJobsService } from '@/lib/services/aiJobsService';
import { projectsService } from '@/lib/services/projectsService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { submitJob, getJob } from '@/lib/ai/motirAiClient';
import type { WorkspaceContext } from '@/lib/workspaces/context';

const ctx: WorkspaceContext = { userId: 'user_1', workspaceId: 'ws_1' };

beforeEach(() => vi.clearAllMocks());

describe('aiJobsService.submitNoopJob', () => {
  it('resolves the project + the workspace org and submits a noop with the right tenant + actor', async () => {
    vi.mocked(projectsService.getByKey).mockResolvedValue({
      id: 'pj_1',
      identifier: 'MOTIR',
      name: 'Motir',
    } as Awaited<ReturnType<typeof projectsService.getByKey>>);
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue({
      id: 'ws_1',
      organizationId: 'org_1',
    } as Awaited<ReturnType<typeof workspaceRepository.findByIdInTx>>);
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiJobsService.submitNoopJob('MOTIR', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    expect(projectsService.getByKey).toHaveBeenCalledWith('MOTIR', ctx);
    expect(workspaceRepository.findByIdInTx).toHaveBeenCalledWith('ws_1', expect.anything());
    expect(submitJob).toHaveBeenCalledWith(
      'noop',
      { organizationId: 'org_1', workspaceId: 'ws_1', projectId: 'pj_1', projectKey: 'MOTIR' },
      {},
      { userId: 'user_1' },
    );
  });

  it('throws when the workspace cannot be resolved (no org to bill)', async () => {
    vi.mocked(projectsService.getByKey).mockResolvedValue({
      id: 'pj_1',
      identifier: 'MOTIR',
      name: 'Motir',
    } as Awaited<ReturnType<typeof projectsService.getByKey>>);
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue(null);

    await expect(aiJobsService.submitNoopJob('MOTIR', ctx)).rejects.toThrow(
      /workspace ws_1 not found/,
    );
    expect(submitJob).not.toHaveBeenCalled();
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
