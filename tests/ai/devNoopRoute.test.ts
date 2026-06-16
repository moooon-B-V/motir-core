import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/workspaces', () => ({ getWorkspaceContext: vi.fn() }));
vi.mock('@/lib/services/aiJobsService', () => ({
  aiJobsService: { submitNoopJob: vi.fn(), getJobStatus: vi.fn() },
}));

import { POST, GET } from '@/app/api/internal/ai/dev/noop/route';
import { getWorkspaceContext } from '@/lib/workspaces';
import { aiJobsService } from '@/lib/services/aiJobsService';
import type { WorkspaceContext } from '@/lib/workspaces/context';

const ctx: WorkspaceContext = { userId: 'u', workspaceId: 'w' };
const url = (q: string) => new Request(`http://x/api/internal/ai/dev/noop${q}`, { method: 'POST' });

beforeEach(() => vi.clearAllMocks());
afterEach(() => delete process.env['AI_DEV_TRIGGER']);

describe('dev noop trigger — gate', () => {
  it('404s (route hidden) when AI_DEV_TRIGGER is off', async () => {
    delete process.env['AI_DEV_TRIGGER'];
    expect((await POST(url('?project=MOTIR'))).status).toBe(404);
    expect((await GET(new Request('http://x/api/internal/ai/dev/noop?jobId=j'))).status).toBe(404);
  });
});

describe('dev noop trigger — enabled', () => {
  beforeEach(() => {
    process.env['AI_DEV_TRIGGER'] = '1';
  });

  it('401s without a session', async () => {
    vi.mocked(getWorkspaceContext).mockResolvedValue(null);
    expect((await POST(url('?project=MOTIR'))).status).toBe(401);
  });

  it('400s without a project param', async () => {
    vi.mocked(getWorkspaceContext).mockResolvedValue(ctx);
    expect((await POST(url(''))).status).toBe(400);
  });

  it('submits a noop and returns the jobId', async () => {
    vi.mocked(getWorkspaceContext).mockResolvedValue(ctx);
    vi.mocked(aiJobsService.submitNoopJob).mockResolvedValue({ jobId: 'job_42' });

    const res = await POST(url('?project=MOTIR'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 'job_42' });
    expect(aiJobsService.submitNoopJob).toHaveBeenCalledWith('MOTIR', ctx);
  });

  it('GET proxies the job status', async () => {
    vi.mocked(getWorkspaceContext).mockResolvedValue(ctx);
    vi.mocked(aiJobsService.getJobStatus).mockResolvedValue({
      jobId: 'j',
      status: 'running',
      result: null,
      error: null,
    });
    const res = await GET(new Request('http://x/api/internal/ai/dev/noop?jobId=j'));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('running');
  });
});
