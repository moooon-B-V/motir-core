import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit test for the shared job-submit org resolver. Both context wrappers are
// stubbed to invoke their callback with a fake tx, so the two reads (workspace org
// id, then the org's `isMeta`) are plain mocked repository calls — no DB.
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: vi.fn() },
}));
vi.mock('@/lib/repositories/organizationRepository', () => ({
  organizationRepository: { findByIdInTx: vi.fn() },
}));
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@/lib/organizations/context', () => ({
  withOrgContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';

const ctx = { userId: 'user_1', workspaceId: 'ws_1' };

beforeEach(() => vi.clearAllMocks());

describe('resolveTenantOrg', () => {
  it('returns the workspace org id + its isMeta flag (META org)', async () => {
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue({
      organizationId: 'org_1',
    } as Awaited<ReturnType<typeof workspaceRepository.findByIdInTx>>);
    vi.mocked(organizationRepository.findByIdInTx).mockResolvedValue({
      id: 'org_1',
      isMeta: true,
    } as Awaited<ReturnType<typeof organizationRepository.findByIdInTx>>);

    const out = await resolveTenantOrg(ctx);

    expect(out).toEqual({ organizationId: 'org_1', isMeta: true });
    expect(workspaceRepository.findByIdInTx).toHaveBeenCalledWith('ws_1', expect.anything());
    expect(organizationRepository.findByIdInTx).toHaveBeenCalledWith('org_1', expect.anything());
  });

  it('defaults isMeta to false for a non-meta org', async () => {
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue({
      organizationId: 'org_1',
    } as Awaited<ReturnType<typeof workspaceRepository.findByIdInTx>>);
    vi.mocked(organizationRepository.findByIdInTx).mockResolvedValue({
      id: 'org_1',
      isMeta: false,
    } as Awaited<ReturnType<typeof organizationRepository.findByIdInTx>>);

    await expect(resolveTenantOrg(ctx)).resolves.toEqual({
      organizationId: 'org_1',
      isMeta: false,
    });
  });

  it('defaults isMeta to false when the org row is missing/hidden', async () => {
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue({
      organizationId: 'org_1',
    } as Awaited<ReturnType<typeof workspaceRepository.findByIdInTx>>);
    vi.mocked(organizationRepository.findByIdInTx).mockResolvedValue(null);

    await expect(resolveTenantOrg(ctx)).resolves.toEqual({
      organizationId: 'org_1',
      isMeta: false,
    });
  });

  it('throws when the workspace cannot be resolved (no org to bill)', async () => {
    vi.mocked(workspaceRepository.findByIdInTx).mockResolvedValue(null);
    await expect(resolveTenantOrg(ctx)).rejects.toThrow(/workspace ws_1 not found/);
    expect(organizationRepository.findByIdInTx).not.toHaveBeenCalled();
  });
});
