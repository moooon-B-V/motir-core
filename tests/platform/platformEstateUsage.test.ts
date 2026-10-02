import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawPlatformUsage } from '@/lib/ai/motirAiClient';

/**
 * Usage & cost's read (Story MOTIR-727 · MOTIR-732) — `platformReadService.getEstateUsage`
 * over the real database: one `estate.read` per view whether or not motir-ai
 * answered, motir-ai unreachable as a state, the gate before anything.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const usageMock = vi.fn<(q: unknown) => Promise<RawPlatformUsage>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return { ...actual, getPlatformUsage: (q: unknown) => usageMock(q) };
});

const { db } = await import('@/lib/db');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const USAGE: RawPlatformUsage = {
  period: '2026-09',
  level: 'platform',
  entityId: '',
  categories: [],
  models: { planning_tokens: [], agent_tokens: [] },
  spend: {
    chargedCredits: 0,
    chargedCostMicroUsd: 0,
    costMicroUsdInclIndexing: 0,
    machineSeconds: 0,
  },
  orgsWithSpend: 0,
};

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+usage@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  usageMock.mockReset();
  usageMock.mockResolvedValue(USAGE);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformReadService.getEstateUsage', () => {
  it('reads the platform level for the period and writes exactly one estate.read row', async () => {
    const result = await platformReadService.getEstateUsage(currentPrincipal!, '2026-09');
    expect(usageMock).toHaveBeenCalledWith({ period: '2026-09', level: 'platform' });
    expect(result).toEqual({ period: '2026-09', usage: USAGE });
    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'estate usage 2026-09',
    });
  });

  it('motir-ai unreachable is `usage: null` — no throw — and the view is still audited once', async () => {
    usageMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await platformReadService.getEstateUsage(currentPrincipal!, 'all')).toEqual({
      period: 'all',
      usage: null,
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('refuses a non-staff caller before reading or auditing', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(platformReadService.getEstateUsage(principal, 'all')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(usageMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});
