import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client + the project resolver + the shared org/meta resolver
// (no network, no DB). resolveTenantOrg is the one seam that reads the workspace's
// org + its `isMeta` flag; mocking it keeps this a pure dispatch-threading test
// (the helper itself is covered by tenantOrg.test.ts).
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getJob: vi.fn() }));
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey: vi.fn() } }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { aiJobsService } from '@/lib/services/aiJobsService';
import { projectsService } from '@/lib/services/projectsService';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
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
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: false });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiJobsService.submitNoopJob('MOTIR', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    expect(projectsService.getByKey).toHaveBeenCalledWith('MOTIR', ctx);
    expect(resolveTenantOrg).toHaveBeenCalledWith({ userId: 'user_1', workspaceId: 'ws_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'noop',
      {
        organizationId: 'org_1',
        isMeta: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
      },
      {},
      { userId: 'user_1' },
    );
  });

  it('threads the META flag onto the tenant so motir-ai bypasses the credit gate', async () => {
    vi.mocked(projectsService.getByKey).mockResolvedValue({
      id: 'pj_1',
      identifier: 'MOTIR',
      name: 'Motir',
    } as Awaited<ReturnType<typeof projectsService.getByKey>>);
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: true });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    await aiJobsService.submitNoopJob('MOTIR', ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'noop',
      expect.objectContaining({ organizationId: 'org_1', isMeta: true }),
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
    vi.mocked(resolveTenantOrg).mockRejectedValue(new Error('workspace ws_1 not found'));

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
