import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The Enterprise-request console's Server ACTIONS (MOTIR-7608) — their result
 * codes. Transport only: the rules live in `platformEnterpriseRequestService`
 * (`platformEnterpriseRequestService.test.ts`). Asserted here: each refusal the
 * page draws differently reaches it as its own code, never collapsed into
 * `FAILED`, and a move or a stale refusal revalidates the list and the detail.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const {
  getEnterpriseRequestAction,
  listEnterpriseRequestsAction,
  transitionEnterpriseRequestAction,
} = await import('@/app/(admin)/admin/enterprise-requests/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+er-action-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedRequest() {
  const owner = await createTestUser({ email: `owner-er-action-${seq++}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const row = await adminDb.enterpriseRequest.create({
    data: {
      organizationId: workspace.organizationId,
      requestedById: owner.id,
      contact: owner.email,
      note: 'Please call.',
    },
  });
  return { id: row.id, organizationId: workspace.organizationId };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('operator');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the Enterprise-request actions', () => {
  it('lists and reads, and translates a bad query and a missing request', async () => {
    const req = await seedRequest();

    const list = await listEnterpriseRequestsAction(null, null);
    expect(list.ok && list.page.requests.map((r) => r.id)).toEqual([req.id]);
    expect(await listEnterpriseRequestsAction('closed', null)).toEqual({
      ok: false,
      code: 'INVALID_QUERY',
    });

    const got = await getEnterpriseRequestAction(req.id);
    expect(got.ok && got.detail.request.id).toBe(req.id);
    expect(await getEnterpriseRequestAction('nope')).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('moves, revalidating the list and the detail', async () => {
    const req = await seedRequest();
    expect(
      await transitionEnterpriseRequestAction(req.id, req.organizationId, 'new', 'contacted'),
    ).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/enterprise-requests');
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/enterprise-requests/${req.id}`);
  });

  it('answers STALE with the current state and the mover', async () => {
    const req = await seedRequest();
    await transitionEnterpriseRequestAction(req.id, req.organizationId, 'new', 'contacted');
    const mover = currentPrincipal!;

    expect(
      await transitionEnterpriseRequestAction(req.id, req.organizationId, 'new', 'lost'),
    ).toEqual({
      ok: false,
      code: 'STALE',
      currentStatus: 'contacted',
      movedBy: { userId: mover.userId, email: mover.email },
    });
  });

  it('answers ILLEGAL_TRANSITION, NOT_FOUND and NOT_PERMITTED as their own codes', async () => {
    const req = await seedRequest();
    expect(
      await transitionEnterpriseRequestAction(req.id, req.organizationId, 'new', 'won'),
    ).toEqual({ ok: false, code: 'ILLEGAL_TRANSITION' });
    expect(
      await transitionEnterpriseRequestAction('nope', req.organizationId, 'new', 'contacted'),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });

    currentPrincipal = await seedStaff('support');
    expect(
      await transitionEnterpriseRequestAction(req.id, req.organizationId, 'new', 'contacted'),
    ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect((await listEnterpriseRequestsAction(null, null)).ok).toBe(true);

    currentPrincipal = null;
    expect(await listEnterpriseRequestsAction(null, null)).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
  });
});
