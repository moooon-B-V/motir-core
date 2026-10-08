import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { EnterpriseRequestStatus } from '@/generated/prisma/client';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  ENTERPRISE_REQUEST_STATUSES,
  type EnterpriseRequestStatusValue,
} from '@/lib/dto/platformEnterpriseRequest';
import {
  EnterpriseRequestIllegalTransitionError,
  EnterpriseRequestStaleError,
  NotPlatformStaffError,
  PlatformEnterpriseRequestNotFoundError,
  PlatformEnterpriseRequestQueryInvalidError,
} from '@/lib/platform/errors';
import {
  isLegalEnterpriseRequestMove,
  platformEnterpriseRequestService,
} from '@/lib/services/platformEnterpriseRequestService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { warmPool } from '../helpers/warmPool';

/**
 * The console's ENTERPRISE REQUESTS (Story MOTIR-7602 · MOTIR-7608) —
 * `platformEnterpriseRequestService` on the real Postgres, under the real
 * `app.platform_staff` arm of `enterprise_request`.
 *
 * Pins: the list (open by default, 50 a page, keyset cursor, every segment's
 * count, one `estate.read` row per call); the detail with its History from the
 * `enterprise_request.transition` rows; every edge of the lifecycle applied or
 * refused; `support` reads but never moves; and the race — two operators moving
 * one request from `new` at once, exactly one applied.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` stand-in; the DEGREE is honoured by
    // re-running the real ladder comparison.
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

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+enterprise-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedOrg(name = 'Acme') {
  const owner = await createTestUser({ email: `owner-enterprise-${++seq}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return { owner, organizationId: workspace.organizationId };
}

async function seedRequest(
  organizationId: string,
  requestedById: string | null,
  status: EnterpriseRequestStatus = 'new',
  createdAt = new Date(),
) {
  return adminDb.enterpriseRequest.create({
    data: {
      organizationId,
      requestedById,
      status,
      contact: 'buyer@example.com',
      note: 'Please call.',
      cardsPerDay: 40,
      tierKeyAtRequest: 'team',
      createdAt,
      closedAt: status === 'won' || status === 'lost' ? createdAt : null,
    },
  });
}

async function auditRows(action?: string) {
  return adminDb.platformAuditLog.findMany({
    where: action ? { action } : {},
    orderBy: { seq: 'asc' },
  });
}

let operator: PlatformPrincipal;

beforeEach(async () => {
  vi.clearAllMocks();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  operator = await seedStaff('operator');
  currentPrincipal = operator;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('list', () => {
  it('returns open requests newest first with the parties, counts and one estate.read row', async () => {
    const a = await seedOrg('Acme');
    const b = await seedOrg('Globex');
    const older = await seedRequest(a.organizationId, a.owner.id, 'contacted', new Date(1_000));
    const newer = await seedRequest(b.organizationId, b.owner.id, 'new', new Date(2_000));
    const c = await seedOrg('Initech');
    await seedRequest(c.organizationId, c.owner.id, 'won', new Date(3_000));

    const page = await platformEnterpriseRequestService.list(operator);

    expect(page.filter).toBe('open');
    expect(page.requests.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(page.requests[0]).toMatchObject({
      status: 'new',
      organizationId: b.organizationId,
      organizationName: 'Globex',
      tierKeyAtRequest: 'team',
      requester: { id: b.owner.id, email: b.owner.email },
      cardsPerDay: 40,
      closedAt: null,
    });
    expect(page.total).toBe(2);
    expect(page.counts).toEqual({
      open: 2,
      new: 1,
      contacted: 1,
      offer_sent: 0,
      won: 1,
      lost: 0,
      all: 3,
    });
    expect(page.nextCursor).toBeNull();
    expect(page.pageSize).toBe(50);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'estate.read', actorUserId: operator.userId });
  });

  it('narrows by a status filter, and All covers every state', async () => {
    const a = await seedOrg();
    await seedRequest(a.organizationId, a.owner.id, 'lost', new Date(1_000));
    const b = await seedOrg();
    const open = await seedRequest(b.organizationId, b.owner.id, 'offer_sent', new Date(2_000));

    const lost = await platformEnterpriseRequestService.list(operator, { status: 'lost' });
    expect(lost.requests.map((r) => r.status)).toEqual(['lost']);
    expect(lost.total).toBe(1);

    const won = await platformEnterpriseRequestService.list(operator, { status: 'won' });
    expect(won.requests).toEqual([]);
    expect(won.total).toBe(0);

    const all = await platformEnterpriseRequestService.list(operator, { status: 'all' });
    expect(all.requests.map((r) => r.id)[0]).toBe(open.id);
    expect(all.total).toBe(2);
  });

  it('pages 50 at a time by cursor, with the total across pages', async () => {
    const created: string[] = [];
    for (let i = 0; i < 53; i++) {
      const org = await seedOrg(`Org ${i}`);
      const row = await seedRequest(org.organizationId, org.owner.id, 'new', new Date(10_000 + i));
      created.push(row.id);
    }
    const newestFirst = [...created].reverse();

    const first = await platformEnterpriseRequestService.list(operator);
    expect(first.requests).toHaveLength(50);
    expect(first.total).toBe(53);
    expect(first.requests.map((r) => r.id)).toEqual(newestFirst.slice(0, 50));
    expect(first.nextCursor).toBe(newestFirst[49]);

    const second = await platformEnterpriseRequestService.list(operator, {
      cursor: first.nextCursor,
    });
    expect(second.requests.map((r) => r.id)).toEqual(newestFirst.slice(50));
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(53);
  });

  it('refuses an unknown filter or cursor', async () => {
    await expect(
      platformEnterpriseRequestService.list(operator, { status: 'closed' }),
    ).rejects.toBeInstanceOf(PlatformEnterpriseRequestQueryInvalidError);
    await expect(
      platformEnterpriseRequestService.list(operator, { cursor: 'not-a-request' }),
    ).rejects.toBeInstanceOf(PlatformEnterpriseRequestQueryInvalidError);
  });

  it('is refused to a non-staff caller', async () => {
    currentPrincipal = null;
    await expect(platformEnterpriseRequestService.list(operator)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });
});

describe('get', () => {
  it('returns the request, its moves for an operator, an empty history, and one estate.read row', async () => {
    const org = await seedOrg('Acme');
    const req = await seedRequest(org.organizationId, org.owner.id);

    const detail = await platformEnterpriseRequestService.get(operator, req.id);

    expect(detail.request).toMatchObject({ id: req.id, status: 'new', organizationName: 'Acme' });
    expect(detail.history).toEqual([]);
    expect(detail.moves).toEqual(['contacted', 'lost']);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'estate.read', metadata: { requestId: req.id } });
  });

  it('returns the history oldest first, one entry per applied move, with who moved it', async () => {
    const org = await seedOrg();
    const req = await seedRequest(org.organizationId, org.owner.id);
    const second = await seedStaff('superadmin');
    const move = { organizationId: org.organizationId };

    await platformEnterpriseRequestService.transition(operator, req.id, {
      ...move,
      from: 'new',
      to: 'contacted',
    });
    currentPrincipal = second;
    await platformEnterpriseRequestService.transition(second, req.id, {
      ...move,
      from: 'contacted',
      to: 'offer_sent',
    });
    await platformEnterpriseRequestService.transition(second, req.id, {
      ...move,
      from: 'offer_sent',
      to: 'won',
    });

    const detail = await platformEnterpriseRequestService.get(second, req.id);
    expect(detail.history.map((h) => [h.from, h.to, h.actorUserId, h.actorEmail])).toEqual([
      ['new', 'contacted', operator.userId, operator.email],
      ['contacted', 'offer_sent', second.userId, second.email],
      ['offer_sent', 'won', second.userId, second.email],
    ]);
    expect(detail.request.status).toBe('won');
    expect(detail.request.closedAt).not.toBeNull();
    expect(detail.moves).toEqual([]);
  });

  it('a support viewer reads everything and is offered no move', async () => {
    const org = await seedOrg();
    const req = await seedRequest(org.organizationId, org.owner.id, 'contacted');
    const support = await seedStaff('support');
    currentPrincipal = support;

    const detail = await platformEnterpriseRequestService.get(support, req.id);
    expect(detail.request.status).toBe('contacted');
    expect(detail.moves).toEqual([]);
    expect((await platformEnterpriseRequestService.list(support)).total).toBe(1);
  });

  it('404s an unknown id', async () => {
    await expect(platformEnterpriseRequestService.get(operator, 'nope')).rejects.toBeInstanceOf(
      PlatformEnterpriseRequestNotFoundError,
    );
  });
});

describe('transition', () => {
  const LEGAL: [EnterpriseRequestStatusValue, EnterpriseRequestStatusValue][] = [
    ['new', 'contacted'],
    ['contacted', 'offer_sent'],
    ['offer_sent', 'won'],
    ['new', 'lost'],
    ['contacted', 'lost'],
    ['offer_sent', 'lost'],
  ];
  const isLegal = (from: string, to: string) => LEGAL.some(([f, t]) => f === from && t === to);
  const ALL_PAIRS = ENTERPRISE_REQUEST_STATUSES.flatMap((from) =>
    ENTERPRISE_REQUEST_STATUSES.map((to) => [from, to] as const),
  );

  it('the edge set is exactly the lifecycle — checked over every pair of states', () => {
    for (const [from, to] of ALL_PAIRS) {
      expect(isLegalEnterpriseRequestMove(from, to), `${from} → ${to}`).toBe(isLegal(from, to));
    }
  });

  it.each(LEGAL)(
    'applies %s → %s, sets closedAt only on a closed state, and writes one audit row',
    async (from, to) => {
      const org = await seedOrg('Acme');
      const req = await seedRequest(org.organizationId, org.owner.id, from);

      await platformEnterpriseRequestService.transition(operator, req.id, {
        organizationId: org.organizationId,
        from,
        to,
      });

      const row = await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(row.status).toBe(to);
      if (to === 'won' || to === 'lost') expect(row.closedAt).not.toBeNull();
      else expect(row.closedAt).toBeNull();

      const rows = await auditRows('enterprise_request.transition');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: operator.userId,
        actorRole: 'operator',
        targetKind: 'organization',
        targetId: org.organizationId,
        organizationId: org.organizationId,
        metadata: { requestId: req.id, from, to },
      });
      expect(rows[0]!.reason?.trim()).toBeTruthy();
    },
  );

  it.each(ALL_PAIRS.filter(([f, t]) => !isLegal(f, t)))(
    'refuses %s → %s as illegal, changing and recording nothing',
    async (from, to) => {
      const org = await seedOrg();
      const req = await seedRequest(org.organizationId, org.owner.id, from);

      await expect(
        platformEnterpriseRequestService.transition(operator, req.id, {
          organizationId: org.organizationId,
          from,
          to,
        }),
      ).rejects.toBeInstanceOf(EnterpriseRequestIllegalTransitionError);

      expect(
        (await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
      ).toBe(from);
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('refuses a support principal with the console role error', async () => {
    const org = await seedOrg();
    const req = await seedRequest(org.organizationId, org.owner.id);
    const support = await seedStaff('support');
    currentPrincipal = support;

    await expect(
      platformEnterpriseRequestService.transition(support, req.id, {
        organizationId: org.organizationId,
        from: 'new',
        to: 'contacted',
      }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(
      (await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe('new');
    expect(await auditRows()).toHaveLength(0);
  });

  it('a move from a state the request has left is STALE, naming the state and who moved it', async () => {
    const org = await seedOrg();
    const req = await seedRequest(org.organizationId, org.owner.id);
    const other = await seedStaff('operator');
    const move = { organizationId: org.organizationId };

    await platformEnterpriseRequestService.transition(other, req.id, {
      ...move,
      from: 'new',
      to: 'contacted',
    });
    const err = await platformEnterpriseRequestService
      .transition(operator, req.id, { ...move, from: 'new', to: 'lost' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(EnterpriseRequestStaleError);
    expect((err as EnterpriseRequestStaleError).currentStatus).toBe('contacted');
    expect((err as EnterpriseRequestStaleError).movedBy).toEqual({
      userId: other.userId,
      email: other.email,
    });
    // The refused move rolled its audit row back.
    expect(await auditRows('enterprise_request.transition')).toHaveLength(1);
  });

  it('404s an unknown id, and an id named under another organization, recording nothing', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const req = await seedRequest(a.organizationId, a.owner.id);

    await expect(
      platformEnterpriseRequestService.transition(operator, 'nope', {
        organizationId: a.organizationId,
        from: 'new',
        to: 'contacted',
      }),
    ).rejects.toBeInstanceOf(PlatformEnterpriseRequestNotFoundError);
    await expect(
      platformEnterpriseRequestService.transition(operator, req.id, {
        organizationId: b.organizationId,
        from: 'new',
        to: 'contacted',
      }),
    ).rejects.toBeInstanceOf(PlatformEnterpriseRequestNotFoundError);

    expect(
      (await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } })).status,
    ).toBe('new');
    expect(await auditRows()).toHaveLength(0);
  });

  it('two operators moving one request from new at once: exactly one applies, the other is STALE', async () => {
    const org = await seedOrg();
    const req = await seedRequest(org.organizationId, org.owner.id);
    const other = await seedStaff('operator');
    await warmPool();

    const outcomes = await Promise.allSettled([
      platformEnterpriseRequestService.transition(operator, req.id, {
        organizationId: org.organizationId,
        from: 'new',
        to: 'contacted',
      }),
      platformEnterpriseRequestService.transition(other, req.id, {
        organizationId: org.organizationId,
        from: 'new',
        to: 'lost',
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = outcomes[0]!.status === 'fulfilled' ? 'contacted' : 'lost';
    const reason = rejected[0]!.reason as EnterpriseRequestStaleError;
    expect(reason).toBeInstanceOf(EnterpriseRequestStaleError);
    expect(reason.currentStatus).toBe(winner);

    const row = await adminDb.enterpriseRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe(winner);
    const moves = await auditRows('enterprise_request.transition');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.metadata).toMatchObject({ from: 'new', to: winner });
  });
});
