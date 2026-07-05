import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the motir-ai boundary client + the two DB-backed resolvers, so this is a
// pure dispatch/gating test (no network, no DB) — the same convention the
// aiJobsService / aiPreplanService service tests use. The helpers themselves are
// covered by tenantOrg.test.ts / codeContext.test.ts.
vi.mock('@/lib/ai/motirAiClient', () => ({ submitJob: vi.fn(), getPreplanState: vi.fn() }));
vi.mock('@/lib/ai/codeContext', () => ({ resolveCodeContext: vi.fn() }));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));

import {
  conventionEstablishService,
  platformToStackHint,
} from '@/lib/services/conventionEstablishService';
import { submitJob, getPreplanState } from '@/lib/ai/motirAiClient';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { RawPreplanStateResponse } from '@/lib/ai/types';

const input = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  projectKey: 'MOTIR',
};

// A minimal preplan wire body with a given platform (the rest is irrelevant here).
function preplanWith(platform: string | null): RawPreplanStateResponse {
  return {
    session: platform === null ? null : ({ platform } as RawPreplanStateResponse['session']),
    docs: [],
    catalog: null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('platformToStackHint', () => {
  it('maps web (and the null = web default) to the typescript starter hint', () => {
    expect(platformToStackHint('web')).toBe('typescript');
    expect(platformToStackHint(null)).toBe('typescript');
    expect(platformToStackHint(undefined)).toBe('typescript');
  });

  it('returns NO hint for a platform with no pinned Motir starter (→ motir-ai derives generic)', () => {
    expect(platformToStackHint('desktop')).toBeUndefined();
    expect(platformToStackHint('mobile')).toBeUndefined();
    expect(platformToStackHint('other')).toBeUndefined();
  });
});

describe('conventionEstablishService.establishForFreshProject — FRESH gate', () => {
  it('does NOT submit when the workspace has a connected repo (the migrate path owns the convention)', async () => {
    vi.mocked(resolveCodeContext).mockResolvedValue({
      repos: [{ provider: 'github', repoRef: 'acme/app', defaultBranch: 'main' }],
    });

    const result = await conventionEstablishService.establishForFreshProject(input);

    expect(result).toEqual({ submitted: false, reason: 'has_connected_repo' });
    // Short-circuits BEFORE resolving the tenant or reaching motir-ai — so a
    // repo-backed onboarding never hits the not-yet-wired migrate seam.
    expect(resolveTenantOrg).not.toHaveBeenCalled();
    expect(getPreplanState).not.toHaveBeenCalled();
    expect(submitJob).not.toHaveBeenCalled();
  });
});

describe('conventionEstablishService.establishForFreshProject — FRESH submit', () => {
  beforeEach(() => {
    // No connected repo → fresh establish-only path.
    vi.mocked(resolveCodeContext).mockResolvedValue(undefined);
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: false });
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
  });

  it('submits propose_convention with the project tenant + the web stack hint read over the 7.1 boundary', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith('web'));

    const result = await conventionEstablishService.establishForFreshProject(input);

    // Reads the pinned stack over the boundary, keyed by the core ids only.
    expect(getPreplanState).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
    });
    expect(submitJob).toHaveBeenCalledWith(
      'propose_convention',
      {
        organizationId: 'org_1',
        isMeta: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
      },
      { code: { stack: 'typescript' } },
      { userId: 'user_1' },
    );
    expect(result).toEqual({ submitted: true, jobId: 'job_1', stackHint: 'typescript' });
  });

  it('threads the META flag onto the tenant so motir-ai bypasses the credit gate', async () => {
    vi.mocked(resolveTenantOrg).mockResolvedValue({ organizationId: 'org_1', isMeta: true });
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith('web'));

    await conventionEstablishService.establishForFreshProject(input);

    expect(submitJob).toHaveBeenCalledWith(
      'propose_convention',
      expect.objectContaining({ isMeta: true }),
      expect.anything(),
      { userId: 'user_1' },
    );
  });

  it('sends NO stack hint for a platform without a pinned starter (motir-ai derives generic)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith('mobile'));

    const result = await conventionEstablishService.establishForFreshProject(input);

    expect(submitJob).toHaveBeenCalledWith(
      'propose_convention',
      expect.anything(),
      { code: {} },
      { userId: 'user_1' },
    );
    expect(result).toEqual({ submitted: true, jobId: 'job_1', stackHint: undefined });
  });

  it('is best-effort on the stack read — a boundary failure still submits (generic), never throws', async () => {
    vi.mocked(getPreplanState).mockRejectedValue(new Error('preplan read boom'));

    const result = await conventionEstablishService.establishForFreshProject(input);

    expect(submitJob).toHaveBeenCalledWith(
      'propose_convention',
      expect.anything(),
      { code: {} },
      { userId: 'user_1' },
    );
    expect(result).toEqual({ submitted: true, jobId: 'job_1', stackHint: undefined });
  });

  it('sends a FRESH envelope — the stack hint only, NEVER a repoRef or repos (no audit for fresh)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith('web'));

    await conventionEstablishService.establishForFreshProject(input);

    const context = vi.mocked(submitJob).mock.calls[0]![2] as { code: Record<string, unknown> };
    expect(context.code).not.toHaveProperty('repoRef');
    expect(context.code).not.toHaveProperty('repos');
    expect(Object.keys(context.code)).toEqual(['stack']);
  });
});
