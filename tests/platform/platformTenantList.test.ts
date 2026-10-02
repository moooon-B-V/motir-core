import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawPlatformUsageOrgs, RawSpendRow, SpendListSort } from '@/lib/ai/motirAiClient';

/**
 * The Tenants list (Story MOTIR-727 · MOTIR-7287, design D10) —
 * `platformUsageService.listTenants` over the real database, motir-ai's
 * `/v1/platform/usage/orgs` faked by a stub that keyset-pages like the real route.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const orgsMock = vi.fn<(q: Record<string, unknown>) => Promise<RawPlatformUsageOrgs>>();

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
  return { ...actual, getPlatformUsageOrgs: (q: Record<string, unknown>) => orgsMock(q) };
});

const { db } = await import('@/lib/db');
const { platformUsageService, parseTenantSort, TENANT_LIST_PAGE } =
  await import('@/lib/services/platformUsageService');
const { platformOrganizationRepository } =
  await import('@/lib/repositories/platformOrganizationRepository');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

function spendRow(entityId: string, i: number): RawSpendRow {
  return {
    entityId,
    credits: {
      planning_tokens: (i * 7) % 11,
      agent_tokens: i,
      agent_machine: 0,
      agent_instance: 0,
      agent_storage: 0,
      // A sort column whose values TIE across orgs, so the tiebreak is exercised.
      ci: i % 3,
      search: 0,
    },
    indexingSeconds: i * 60,
    chargedCredits: ((i * 7) % 11) + i + (i % 3),
    costMicroUsd: (i * 13) % 17,
    cost: {
      planning_tokens: 0,
      agent_tokens: 0,
      agent_machine: 0,
      agent_instance: 0,
      agent_storage: 0,
      ci: 0,
      search: 0,
      indexing: 0,
    },
  };
}

const sortValue = (r: RawSpendRow, sort: SpendListSort): number =>
  sort === 'cost'
    ? r.costMicroUsd
    : sort === 'charged'
      ? r.chargedCredits
      : sort === 'indexing'
        ? r.indexingSeconds
        : r.credits[sort];

/** A faithful stub of the route: sort desc, entityId tiebreak, keyset cursor, id filter, estate over ALL. */
function stubRoute(all: RawSpendRow[]) {
  orgsMock.mockImplementation(async (q) => {
    const sort = (q['sort'] as SpendListSort) ?? 'cost';
    const ids = q['coreOrganizationIds'] as string[] | undefined | null;
    const pool = ids ? all.filter((r) => ids.includes(r.entityId)) : all;
    const ordered = [...pool].sort(
      (a, b) => sortValue(b, sort) - sortValue(a, sort) || (a.entityId < b.entityId ? 1 : -1),
    );
    const start = q['cursor'] ? Number(q['cursor']) : 0;
    const limit = q['limit'] as number;
    const items = ordered.slice(start, start + limit);
    const estate = spendRow('platform', 0);
    estate.chargedCredits = all.reduce((s, r) => s + r.chargedCredits, 0);
    estate.costMicroUsd = all.reduce((s, r) => s + r.costMicroUsd, 0);
    return {
      period: q['period'] as string,
      sort,
      items,
      nextCursor: start + limit < ordered.length ? String(start + limit) : null,
      estate,
    };
  });
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+tenants@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  orgsMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedOrgs(names: string[]) {
  const orgs: { id: string; name: string }[] = [];
  for (const name of names) {
    const { workspace } = await createTestWorkspace({ name });
    const org = await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { name },
    });
    orgs.push({ id: org.id, name: org.name });
  }
  return orgs;
}

describe('platformUsageService.listTenants', () => {
  it('lists every org on arrival — the estate total first, names joined — with ONE estate.read row', async () => {
    const orgs = await seedOrgs(['Acme', 'Bravo', 'Charlie']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));

    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
    });
    expect(list.unavailable).toBe(false);
    expect(list.estate!.organization).toBeNull();
    expect(list.rows.map((r) => r.organization!.name).sort()).toEqual(['Acme', 'Bravo', 'Charlie']);
    expect(orgsMock).toHaveBeenCalledWith({
      period: '2026-09',
      sort: 'cost',
      limit: TENANT_LIST_PAGE,
      cursor: null,
    });

    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'tenants 2026-09',
    });
  });

  it.each<SpendListSort>(['cost', 'charged', 'ci'])(
    'sorted by %s, Show more pages through every org exactly once',
    async (sort) => {
      const orgs = await seedOrgs(
        Array.from({ length: TENANT_LIST_PAGE + 7 }, (_, i) => `Org ${i}`),
      );
      stubRoute(orgs.map((o, i) => spendRow(o.id, i)));

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const list = await platformUsageService.listTenants(currentPrincipal!, {
          period: 'all',
          sort,
          cursor,
        });
        seen.push(...list.rows.map((r) => r.organization!.id));
        cursor = list.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toHaveLength(orgs.length);
      expect(new Set(seen)).toEqual(new Set(orgs.map((o) => o.id)));
    },
  );

  it('a name/slug filter narrows BEFORE the remote read, and the estate row still describes the whole estate', async () => {
    const orgs = await seedOrgs(['Acme Labs', 'Acme Studio', 'Bravo']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const whole = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
    });

    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
      filter: '  acme ',
    });
    const asked = orgsMock.mock.calls.at(-1)![0]['coreOrganizationIds'] as string[];
    expect(new Set(asked)).toEqual(new Set(orgs.slice(0, 2).map((o) => o.id)));
    expect(list.filter).toBe('acme');
    expect(list.rows.map((r) => r.organization!.name).sort()).toEqual(['Acme Labs', 'Acme Studio']);
    expect(list.estate).toEqual(whole.estate);
    expect(await adminDb.platformAuditLog.count()).toBe(2);
  });

  it('a filter matching no organization asks for none, and the estate row still stands', async () => {
    const orgs = await seedOrgs(['Acme']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: '2026-09',
      sort: 'cost',
      filter: 'zzz',
    });
    expect(orgsMock.mock.calls.at(-1)![0]['coreOrganizationIds']).toEqual([]);
    expect(list.rows).toEqual([]);
    expect(list.estate).not.toBeNull();
  });

  it('a one-character filter is no filter', async () => {
    const orgs = await seedOrgs(['Acme', 'Bravo']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const list = await platformUsageService.listTenants(currentPrincipal!, {
      period: 'all',
      sort: 'cost',
      filter: 'a',
    });
    expect(list.filter).toBe('');
    expect(list.rows).toHaveLength(2);
  });

  it('motir-ai unreachable is the error state — no throw — on both paths, each view audited once', async () => {
    await seedOrgs(['Acme']);
    orgsMock.mockRejectedValue(new Error('ECONNREFUSED'));
    for (const filter of ['', 'acme']) {
      const list = await platformUsageService.listTenants(currentPrincipal!, {
        period: 'all',
        sort: 'cost',
        filter,
      });
      expect(list).toMatchObject({ unavailable: true, estate: null, rows: [] });
    }
    expect(await adminDb.platformAuditLog.count()).toBe(2);
  });

  it('a read that throws inside the transaction writes no audit row', async () => {
    const orgs = await seedOrgs(['Acme']);
    stubRoute(orgs.map((o, i) => spendRow(o.id, i + 1)));
    const spy = vi
      .spyOn(platformOrganizationRepository, 'findOrganizationsByIds')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(
      platformUsageService.listTenants(currentPrincipal!, { period: 'all', sort: 'cost' }),
    ).rejects.toThrow('boom');
    spy.mockRestore();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('refuses a non-staff caller before reading or auditing', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(
      platformUsageService.listTenants(principal, { period: 'all', sort: 'cost' }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(orgsMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('parseTenantSort', () => {
  it('takes cost, charged and the eight categories; anything else is cost', () => {
    expect(parseTenantSort('charged')).toBe('charged');
    expect(parseTenantSort('indexing')).toBe('indexing');
    expect(parseTenantSort('nope')).toBe('cost');
    expect(parseTenantSort(undefined)).toBe('cost');
  });
});
