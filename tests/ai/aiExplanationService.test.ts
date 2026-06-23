import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network) + the shared org/meta resolver, mirroring
// aiChatService.test. The service receives a resolved ProjectContext; the only
// extra read is the workspace ORG + its `isMeta` flag (7.2.16), owned by
// resolveTenantOrg (covered by tenantOrg.test.ts).
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), streamJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import { aiExplanationService } from '@/lib/services/aiExplanationService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

beforeEach(() => vi.clearAllMocks());

describe('aiExplanationService.submitExplanationDraft', () => {
  beforeEach(() => {
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: false });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
  });

  it('submits a generate_explanation job with the tenant + explanation context + actor', async () => {
    const out = await aiExplanationService.submitExplanationDraft(
      {
        title: 'OAuth account merge',
        description: 'Returning Google users get a second account.',
        type: 'code',
        parentKey: 'MOTIR-10',
        parentTitle: 'Auth epic',
      },
      ctx,
    );

    expect(out).toEqual({ jobId: 'job_1' });
    expect(resolveTenantOrg).toHaveBeenCalledWith({ userId: 'user_1', workspaceId: 'ws_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'generate_explanation',
      {
        organizationId: 'org_1',
        isMeta: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
      },
      {
        explanation: {
          title: 'OAuth account merge',
          description: 'Returning Google users get a second account.',
          type: 'code',
          parent: { key: 'MOTIR-10', title: 'Auth epic' },
        },
      },
      { userId: 'user_1' },
    );
  });

  it('omits the parent (null) when no parent key/title is given, defaulting optional fields to null', async () => {
    await aiExplanationService.submitExplanationDraft({ title: 'Standalone task' }, ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'generate_explanation',
      expect.anything(),
      { explanation: { title: 'Standalone task', description: null, type: null, parent: null } },
      { userId: 'user_1' },
    );
  });
});

describe('aiExplanationService.streamExplanation', () => {
  it('relays the client job stream frames for the given jobId', async () => {
    const frames: JobStreamEvent[] = [
      { event: 'token', data: { text: 'Hello ' } },
      { event: 'explanation', data: { explanationMd: 'Hello world.' } },
    ];
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiExplanationService.streamExplanation('job_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1');
    expect(got).toEqual(frames);
  });
});
