import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { VISITORS_PAGE_SIZE, visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// The project's Visitors, for its Managers (Story MOTIR-6170 · MOTIR-6667), through
// the real service, the real route and the real database. The one read that hands
// out a Visitor's email: a Manager of a PUBLIC project gets it, newest latest
// visit first and paged; a Member without `project:manage_access`, a reader of a
// project that is not public, and a request with no session get refused.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { getWorkspaceContext, refuseIfNonCompliant } = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  refuseIfNonCompliant: vi.fn(async () => null),
}));
vi.mock('@/lib/workspaces', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext,
}));
vi.mock('@/lib/auth/requireCompliantSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/requireCompliantSession')>()),
  refuseIfNonCompliant,
}));

const { GET } = await import('@/app/api/projects/[key]/visitors/route');

beforeEach(async () => {
  await truncateAuthTables();
  getWorkspaceContext.mockReset();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const t0 = Date.parse('2026-09-20T10:00:00.000Z');

/** A PUBLIC project whose owner is a Manager, a plain Member, and `n` visitors. */
async function publicProject(n: number, { nameless = -1 } = {}) {
  const identifier = `VM${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VM ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('public'),
  });
  const member = await adminDb.user.create({
    data: { email: `vm-member-${seq++}@example.com`, name: 'Plain Member', emailVerified: true },
  });
  await adminDb.workspaceMembership.create({
    data: {
      userId: member.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    },
  });
  for (let i = 0; i < n; i++) {
    const person = await adminDb.user.create({
      data: {
        email: `visitor-${seq++}-${i}@example.com`,
        name: i === nameless ? '' : `Visitor ${i}`,
        emailVerified: true,
      },
    });
    await db.$transaction((tx) =>
      projectVisitorRepository.upsertConsent(
        { projectId: fx.projectId, userId: person.id, at: new Date(t0 + i * 60_000) },
        tx,
      ),
    );
  }
  const managerCtx = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };
  return { fx, identifier, managerCtx, memberCtx };
}

const get = (key: string, cursor?: string) =>
  GET(
    new Request(
      `http://localhost/api/projects/${key}/visitors${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
    { params: Promise.resolve({ key }) },
  );

describe('a Manager of a public project', () => {
  it('sees each visitor by name and email, newest latest visit first, with the count', async () => {
    const t = await publicProject(2, { nameless: 0 });
    const page = await visitorRecordsService.listForManagers({
      key: t.identifier,
      ctx: t.managerCtx,
    });
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(page.visitors.map((v) => v.name)).toEqual(['Visitor 1', '']);
    expect(page.visitors[1]!.email).toMatch(/@example\.com$/);
    // Exactly the five fields the consent screen said would be shared.
    for (const row of page.visitors) {
      expect(Object.keys(row).sort()).toEqual(
        ['consentedAt', 'email', 'firstVisitAt', 'lastVisitAt', 'name'].sort(),
      );
    }
  });

  it(`pages ${VISITORS_PAGE_SIZE} at a time without repeating or skipping a row, through the route`, async () => {
    const t = await publicProject(VISITORS_PAGE_SIZE + 1);
    getWorkspaceContext.mockResolvedValue(t.managerCtx);
    const first = await get(t.identifier);
    expect(first.status).toBe(200);
    const one = (await first.json()) as {
      visitors: { email: string }[];
      nextCursor: string | null;
      total: number;
    };
    expect(one.visitors).toHaveLength(VISITORS_PAGE_SIZE);
    expect(one.total).toBe(VISITORS_PAGE_SIZE + 1);
    expect(one.nextCursor).not.toBeNull();
    const second = await get(t.identifier, one.nextCursor!);
    const two = (await second.json()) as {
      visitors: { email: string }[];
      nextCursor: string | null;
    };
    expect(two.visitors).toHaveLength(1);
    expect(two.nextCursor).toBeNull();
    const emails = [...one.visitors, ...two.visitors].map((v) => v.email);
    expect(new Set(emails).size).toBe(VISITORS_PAGE_SIZE + 1);
  });
});

describe('everyone else is refused on the server', () => {
  it('a Member without project:manage_access: PermissionDeniedError, and 403 on the route', async () => {
    const t = await publicProject(1);
    await expect(
      visitorRecordsService.listForManagers({ key: t.identifier, ctx: t.memberCtx }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    getWorkspaceContext.mockResolvedValue(t.memberCtx);
    expect((await get(t.identifier)).status).toBe(403);
  });

  it('a project that is not public answers the Manager the same refusal, and keeps its records', async () => {
    const t = await publicProject(1);
    await adminDb.project.update({
      where: { id: t.fx.projectId },
      data: projectAccessData('workspace'),
    });
    await expect(
      visitorRecordsService.listForManagers({ key: t.identifier, ctx: t.managerCtx }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    getWorkspaceContext.mockResolvedValue(t.managerCtx);
    expect((await get(t.identifier)).status).toBe(403);
    expect(await adminDb.projectVisitor.count({ where: { projectId: t.fx.projectId } })).toBe(1);
  });

  it('no session: 401', async () => {
    const t = await publicProject(0);
    getWorkspaceContext.mockResolvedValue(null);
    expect((await get(t.identifier)).status).toBe(401);
  });
});
