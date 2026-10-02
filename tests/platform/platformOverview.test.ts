import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawPlatformRun, RawPlatformRunsPage } from '@/lib/ai/motirAiClient';

/**
 * The estate overview (Story MOTIR-727 · MOTIR-731, design D1/D2) —
 * `platformReadService.getOverview`, over the real database under `motir_app`.
 *
 * What can fail, and is therefore tested: the period deltas, the feed's interleave
 * of tenant events and motir-ai runs on one `(at, id)` keyset (no row lost or
 * repeated across pages), the names a run row borrows from motir-core, motir-ai
 * being unreachable (a state, not an error), one audit row per read, and the gate.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const runsMock = vi.fn<(q: unknown) => Promise<RawPlatformRunsPage>>();

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
  return { ...actual, getPlatformRuns: (q: unknown) => runsMock(q) };
});

const { db } = await import('@/lib/db');
const { platformReadService, periodStart, OVERVIEW_FEED_PAGE } =
  await import('@/lib/services/platformReadService');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-02T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function seedOperator() {
  const user = await createTestUser({ email: 'ops+overview@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  return { userId: user.id, email: user.email, role: 'support' } satisfies PlatformPrincipal;
}

function run(over: Partial<RawPlatformRun> & { id: string; startedAt: string }): RawPlatformRun {
  return {
    kind: 'planning',
    ref: `job_${over.id}`,
    coreOrganizationId: 'org_x',
    coreWorkspaceId: null,
    coreProjectId: null,
    model: 'claude-opus-5-5',
    status: 'succeeded',
    lastActivityAt: over.startedAt,
    inputTokens: 10,
    outputTokens: 5,
    credits: 3,
    ...over,
  };
}

/** Pins every tier row of one tenant to `at`, so the feed's order is the fixture's. */
async function backdate(orgId: string, workspaceId: string, projectId: string | null, at: Date) {
  await adminDb.organization.update({ where: { id: orgId }, data: { createdAt: at } });
  await adminDb.workspace.update({
    where: { id: workspaceId },
    data: { createdAt: new Date(at.getTime() + 1000) },
  });
  if (projectId) {
    await adminDb.project.update({
      where: { id: projectId },
      data: { createdAt: new Date(at.getTime() + 2000) },
    });
  }
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
  runsMock.mockReset();
  runsMock.mockResolvedValue({
    items: [],
    nextCursor: null,
    codingRunsUnattributedExcluded: false,
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('periodStart', () => {
  it('counts 7 and 30 days back, and "this month" from the first of the UTC month', () => {
    expect(periodStart('7d', NOW).toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(periodStart('30d', NOW).toISOString()).toBe('2026-09-02T12:00:00.000Z');
    expect(periodStart('month', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('platformReadService.getOverview', () => {
  it('counts the estate and what arrived in the period, from rows the operator is no member of', async () => {
    const old = await createTestWorkspace({ name: 'Old' });
    const fresh = await createTestWorkspace({ name: 'Fresh' });
    const p = await createTestProject({
      workspaceId: fresh.workspace.id,
      actorUserId: fresh.owner.id,
    });
    await backdate(
      old.workspace.organizationId,
      old.workspace.id,
      null,
      new Date(NOW.getTime() - 40 * DAY),
    );
    await backdate(
      fresh.workspace.organizationId,
      fresh.workspace.id,
      p.id,
      new Date(NOW.getTime() - 3 * DAY),
    );
    await adminDb.user.updateMany({
      where: { id: old.owner.id },
      data: { createdAt: new Date(NOW.getTime() - 40 * DAY) },
    });

    const week = await platformReadService.getOverview(currentPrincipal!, {
      period: '7d',
      now: NOW,
    });
    expect(week.counts).toEqual({ organizations: 2, workspaces: 2, projects: 1, users: 3 });
    expect(week.deltas).toEqual({ organizations: 1, workspaces: 1, projects: 1, users: 2 });
    expect(week.since).toBe('2026-09-25T12:00:00.000Z');

    const month = await platformReadService.getOverview(currentPrincipal!, {
      period: '30d',
      now: NOW,
    });
    expect(month.deltas.organizations).toBe(1);

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'estate overview',
    });
  });

  it('interleaves tenant events with runs newest first, naming the run’s tenant path and each tenant’s owner', async () => {
    const a = await createTestWorkspace({ name: 'Acme WS' });
    const p = await createTestProject({
      workspaceId: a.workspace.id,
      actorUserId: a.owner.id,
      name: 'Mobile',
      identifier: 'MOB',
    });
    const t0 = new Date(NOW.getTime() - 10 * DAY);
    await backdate(a.workspace.organizationId, a.workspace.id, p.id, t0);
    runsMock.mockResolvedValue({
      items: [
        run({
          id: 'r2',
          kind: 'coding',
          startedAt: new Date(t0.getTime() + 5000).toISOString(),
          coreOrganizationId: a.workspace.organizationId,
          coreWorkspaceId: a.workspace.id,
          coreProjectId: p.id,
          credits: 42,
        }),
        run({
          id: 'r1',
          startedAt: new Date(t0.getTime() + 1500).toISOString(),
          coreOrganizationId: a.workspace.organizationId,
        }),
      ],
      nextCursor: null,
      codingRunsUnattributedExcluded: false,
    });

    const o = await platformReadService.getOverview(currentPrincipal!, { period: '7d', now: NOW });
    expect(o.feed.items.map((i) => i.kind)).toEqual([
      'coding_run',
      'new_project',
      'planning_run',
      'new_workspace',
      'new_organization',
    ]);
    const [coding, project, planning, workspace, org] = o.feed.items;
    expect(coding).toMatchObject({
      project: { id: p.id, name: 'Mobile' },
      workspace: { name: 'Acme WS' },
      credits: 42,
      unattributed: false,
    });
    expect(planning).toMatchObject({ unattributed: true, workspace: null, project: null });
    expect(planning!.organization!.name).toBe(org!.organization!.name);
    expect(project!.detail).toBe('MOB');
    expect(workspace!.detail).toBe(a.owner.email);
    expect(org!.detail).toBe(a.owner.email);
    expect(o.feed).toMatchObject({ nextCursor: null, runsUnavailable: false });
  });

  it('pages the merged feed on (at, id) — every row once, none skipped, across both halves', async () => {
    for (let i = 0; i < 9; i += 1) {
      const w = await createTestWorkspace({ name: `W${i}` });
      await backdate(
        w.workspace.organizationId,
        w.workspace.id,
        null,
        new Date(NOW.getTime() - (i * 2 + 1) * 60_000),
      );
    }
    const allRuns = Array.from({ length: 20 }, (_, i) =>
      run({
        id: `run${String(i).padStart(2, '0')}`,
        startedAt: new Date(NOW.getTime() - i * 50_000).toISOString(),
      }),
    );
    // A faithful stub of motir-ai's keyset: everything strictly older than the cursor.
    runsMock.mockImplementation(async (q) => {
      const { cursor, limit } = q as { cursor: string | null; limit: number };
      const pos = cursor
        ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { t: string; i: string })
        : null;
      const older = allRuns.filter(
        (r) => !pos || r.startedAt < pos.t || (r.startedAt === pos.t && r.id < pos.i),
      );
      return {
        items: older.slice(0, limit),
        nextCursor: older.length > limit ? 'more' : null,
        codingRunsUnattributedExcluded: false,
      };
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const o = await platformReadService.getOverview(currentPrincipal!, {
        period: '7d',
        cursor,
        now: NOW,
      });
      expect(o.feed.items.length).toBeLessThanOrEqual(OVERVIEW_FEED_PAGE);
      seen.push(...o.feed.items.map((i) => `${i.kind}:${i.id}`));
      cursor = o.feed.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(9 * 2 + 20);
  });

  it('renders the tenant half when motir-ai cannot be reached — a state, not an error', async () => {
    await createTestWorkspace({ name: 'Solo' });
    runsMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const o = await platformReadService.getOverview(currentPrincipal!, {
      period: 'month',
      now: NOW,
    });
    expect(o.feed.runsUnavailable).toBe(true);
    expect(o.feed.items.map((i) => i.kind)).toEqual(['new_workspace', 'new_organization']);
    expect(o.counts.organizations).toBe(1);
  });

  it('reads a malformed cursor as the first page', async () => {
    await createTestWorkspace({ name: 'Solo' });
    for (const cursor of [
      '%%%',
      Buffer.from('{"t":1}').toString('base64url'),
      Buffer.from('{"t":"nope","i":"x"}').toString('base64url'),
    ]) {
      const o = await platformReadService.getOverview(currentPrincipal!, {
        period: '7d',
        cursor,
        now: NOW,
      });
      expect(o.feed.items).toHaveLength(2);
    }
  });

  it('refuses a non-staff caller before anything is read or audited', async () => {
    currentPrincipal = null;
    await expect(
      platformReadService.getOverview(
        { userId: 'u', email: 'e', role: 'support' },
        { period: '7d' },
      ),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(runsMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});
