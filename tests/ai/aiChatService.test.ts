import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network) + the shared org/meta resolver. The chat
// service receives an already-resolved ProjectContext; the only extra read is the
// workspace ORG + its `isMeta` flag (7.2.16), which resolveTenantOrg owns (covered
// by tenantOrg.test.ts).
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), streamJob: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
// …and the project gate (MOTIR-2355). `submitDiscoveryTurn` now asserts `ai:plan`
// before it does anything else; this file drives a SYNTHETIC ProjectContext with
// no rows behind it, so the real gate would 404 on `pj_1` and prove nothing about
// the job envelope these cases are here for. The gate itself is covered against
// real Postgres in `tests/integration/ai/planPermissionGate.test.ts`; the mock is
// asserted below so it can never quietly hide the call.
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));

import { aiChatService } from '@/lib/services/aiChatService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { projectAccessService } from '@/lib/services/projectAccessService';
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
    vi.mocked(resolveTenantOrg).mockResolvedValue({
      organizationId: 'org_1',
      isMeta: false,
      internalBilling: false,
    });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    const out = await aiChatService.submitDiscoveryTurn('build me a tracker', ctx);

    expect(out).toEqual({ jobId: 'job_1' });
    // The gate runs, and it asks for `ai:plan` on THIS project (MOTIR-2355).
    expect(projectAccessService.assertPermission).toHaveBeenCalledWith(
      'pj_1',
      { userId: 'user_1', workspaceId: 'ws_1' },
      'ai:plan',
    );
    expect(resolveTenantOrg).toHaveBeenCalledWith({ userId: 'user_1', workspaceId: 'ws_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'discovery',
      {
        organizationId: 'org_1',
        isMeta: false,
        internalBilling: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
      },
      { prompt: 'build me a tracker' },
      { userId: 'user_1' },
    );
  });

  it('threads the META flag onto the tenant', async () => {
    vi.mocked(resolveTenantOrg).mockResolvedValue({
      organizationId: 'org_1',
      isMeta: true,
      internalBilling: false,
    });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });

    await aiChatService.submitDiscoveryTurn('build me a tracker', ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'discovery',
      expect.objectContaining({ isMeta: true }),
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
    for await (const f of aiChatService.streamDiscovery('job_1', 'pj_1')) got.push(f);
    // MOTIR-2359 — the core project id rides every stream open.
    expect(streamJob).toHaveBeenCalledWith('job_1', 'pj_1');

    expect(streamJob).toHaveBeenCalledWith('job_1', expect.any(String));
    expect(got).toEqual(frames);
  });
});
