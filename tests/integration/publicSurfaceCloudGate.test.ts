import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PublicAccessUnavailableError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { GET as publicProject } from '@/app/api/public/p/[identifier]/route';
import { GET as publicExplore } from '@/app/api/public/explore/route';

// ⚠️ THE ONE SANCTIONED MOCK, and nothing else (CLAUDE.md: *"the single
// `vi.mock` allowed is for `getSession()` from `@/lib/auth`, since the test
// environment has no cookies"*). `getSession()` reads Next's request scope,
// which exists only inside a request; the subject routes read it to PERSONALISE
// an anonymous answer, so a null session is the visitor this surface is for.
//
// Note which arm needed it: the SELF-HOSTED cases passed without any mock at
// all, because the capability gate returns before the session read. That is the
// gate's placement rule (MOTIR-4036) demonstrated by accident, from the outside.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => null,
}));

// Story MOTIR-3908 · MOTIR-4037 — the ASSEMBLED story, over a real Postgres.
//
// The per-subtask suites each cover their own slice and each STUB the layer
// below: `tests/api/public/cloud-gate.test.ts` drives every handler with the
// services mocked, and `tests/components/project-access-cloud-gate.test.tsx`
// drives the control with no server at all. Both are right for what they check
// and neither can see the seam — whether the guard the routes import is the one
// `isCloud()` actually exports, and whether a REAL public project, readable
// through the real service against real rows, still stops being readable when
// the flag is off.
//
// So this file mocks nothing. It seeds a genuinely public project, drives the
// shipped route both ways, and asserts the SAME request that returns the
// project's own data on a cloud build returns the capability-absent 404 on a
// self-hosted one.
//
// ⚠️ The flag is the only variable between the two arms — same fixture, same
// request, same handler. That is what makes the pair evidence rather than two
// separate observations.

beforeEach(async () => {
  await truncateAuthTables();
});

let previousFlag: string | undefined;
afterEach(() => {
  if (previousFlag === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousFlag;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function cloudBuild(): void {
  previousFlag = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
}
function selfHostedBuild(): void {
  previousFlag = process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_CLOUD'];
}

/** A project that really is `public`, with real rows behind it. */
async function makePublicProjectFixture(name = 'Gatecheck'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

const anonymous = (path: string) => new Request(`https://app.motir.co${path}`);

describe('the public READ surface, end to end, in both builds', () => {
  it('serves a real public project on a CLOUD build', async () => {
    const fx = await makePublicProjectFixture();
    cloudBuild();

    const res = await publicProject(anonymous(`/api/public/p/${fx.projectIdentifier}`), {
      params: Promise.resolve({ identifier: fx.projectIdentifier }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key?: string; identifier?: string };
    // Whichever the DTO names it — the point is that real project data came
    // back, not that the projection has a particular field name.
    expect(JSON.stringify(body)).toContain(fx.projectIdentifier);
  });

  it('…and answers the capability-absent 404 for the SAME project on a self-hosted build', async () => {
    const fx = await makePublicProjectFixture();
    selfHostedBuild();

    const res = await publicProject(anonymous(`/api/public/p/${fx.projectIdentifier}`), {
      params: Promise.resolve({ identifier: fx.projectIdentifier }),
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('the DIRECTORY is empty of doors, not merely empty of projects', async () => {
    // The distinction the story is about: an off-cloud `/explore` that answered
    // `{ items: [] }` would be a working directory that happens to list
    // nothing, and would start listing projects the moment one went public.
    await makePublicProjectFixture('Directory');
    selfHostedBuild();
    const absent = await publicExplore(anonymous('/api/public/explore'));
    expect(absent.status).toBe(404);

    cloudBuild();
    const served = await publicExplore(anonymous('/api/public/explore'));
    expect(served.status).toBe(200);
    expect(await served.json()).toHaveProperty('items');
  });
});

describe('the publish path, end to end, in both builds', () => {
  it('refuses `public` on a self-hosted build and leaves the row untouched', async () => {
    const fx = await makeWorkItemFixture({ name: 'Publish' });
    selfHostedBuild();

    await expect(
      projectMembersService.setAccessLevel({
        key: fx.projectIdentifier,
        actorUserId: fx.ctx.userId,
        ctx: fx.ctx,
        level: 'public',
      }),
    ).rejects.toBeInstanceOf(PublicAccessUnavailableError);

    const row = await adminDb.project.findUnique({ where: { id: fx.projectId } });
    expect(row?.accessLevel).not.toBe('public');
    expect(row?.madePublicAt).toBeNull();
  });

  it('accepts every level a self-hosted team shares within its own workspace', async () => {
    const fx = await makeWorkItemFixture({ name: 'Shares' });
    selfHostedBuild();

    for (const level of ['open', 'limited', 'private'] as const) {
      const res = await projectMembersService.setAccessLevel({
        key: fx.projectIdentifier,
        actorUserId: fx.ctx.userId,
        ctx: fx.ctx,
        level,
      });
      expect(res.accessLevel).toBe(level);
    }
  });

  it('publishes on a cloud build, and the READ surface then serves it — the whole loop', async () => {
    // The seam the two halves of this story share: publishing is only worth
    // anything because the read surface answers, and the read surface is only
    // reachable because something published. One test, one build, both halves.
    const fx = await makeWorkItemFixture({ name: 'Loop' });
    cloudBuild();

    await projectMembersService.setAccessLevel({
      key: fx.projectIdentifier,
      actorUserId: fx.ctx.userId,
      ctx: fx.ctx,
      level: 'public',
    });

    const res = await publicProject(anonymous(`/api/public/p/${fx.projectIdentifier}`), {
      params: Promise.resolve({ identifier: fx.projectIdentifier }),
    });
    expect(res.status).toBe(200);
  });
});
