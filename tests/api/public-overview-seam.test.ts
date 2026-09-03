import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PUBLIC_TAGLINE_MAX_LENGTH } from '@/lib/publicProjects/limits';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { runAsCloudBuild } from '../helpers/cloudBuild';

// THE SEAM the Public page room is built over (Story MOTIR-3875 · MOTIR-4171):
// what the room SAVES through `PATCH /api/projects/{key}/public-overview`
// (MOTIR-4114) is what `motir.co/p/<key>` READS through
// `GET /api/public/p/{identifier}` (MOTIR-3945). The card's criterion is the
// public page's rendered output changing after an edit — the seam, not just the
// write — and the public read is that output's only source, so this file
// drives BOTH doors against the real database: the write as the admin's
// session, the read anonymously, exactly as the two hosts do.
//
// Why real Postgres and not the route tests' mocks: each route's own test
// mocks the service it calls and asserts the HTTP posture; neither can say the
// bytes the room sent are the bytes the public page gets back, which is the one
// thing this card's seam criterion is about. Both routes are cloud-gated, so
// the file runs as a cloud build.

runAsCloudBuild();

const getSession = vi.hoisted(() => vi.fn());
// Only the session read is replaced — the rest of `@/lib/auth` stays real, so
// nothing in the services' import chain meets a hollow module.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession,
}));

const { PATCH } = await import('@/app/api/projects/[key]/public-overview/route');
const { GET } = await import('@/app/api/public/p/[identifier]/route');

const patch = (key: string, body: unknown) =>
  PATCH(
    new Request(`https://app.motir.co/api/projects/${key}/public-overview`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );

async function readPublic(identifier: string) {
  // Anonymous — the public page's own posture.
  getSession.mockResolvedValueOnce(null);
  const res = await GET(new Request(`https://motir.co/api/public/p/${identifier}`), {
    params: Promise.resolve({ identifier }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    publicOverviewMd: string | null;
    publicTagline: string | null;
    publicTags: string[];
  };
}

async function makePublicProjectFixture(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name: 'Acme' });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => vi.clearAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the room saves, the public page reads (MOTIR-4171)', () => {
  it('an admin’s PATCH of all three fields is what the anonymous public read returns', async () => {
    const fx = await makePublicProjectFixture();
    getSession.mockResolvedValueOnce({ user: { id: fx.ownerId } });

    const res = await patch(fx.projectIdentifier, {
      publicOverviewMd: '# Acme\n\nWhat we are building.',
      publicTagline: 'One sentence about Acme.',
      publicTags: ['planning', 'agents'],
    });
    expect(res.status).toBe(204);

    const overview = await readPublic(fx.projectIdentifier);
    expect(overview.publicOverviewMd).toBe('# Acme\n\nWhat we are building.');
    expect(overview.publicTagline).toBe('One sentence about Acme.');
    expect(overview.publicTags).toEqual(['planning', 'agents']);
  });

  it('the partial-author contract: a null tagline CLEARS, an absent field is UNTOUCHED', async () => {
    const fx = await makePublicProjectFixture();
    getSession.mockResolvedValue({ user: { id: fx.ownerId } });

    expect(
      (
        await patch(fx.projectIdentifier, {
          publicOverviewMd: 'Body',
          publicTagline: 'Tagline',
          publicTags: ['a'],
        })
      ).status,
    ).toBe(204);

    // The room always sends all three; an emptied tagline travels as null.
    expect(
      (
        await patch(fx.projectIdentifier, {
          publicOverviewMd: 'Body',
          publicTagline: null,
          publicTags: ['a'],
        })
      ).status,
    ).toBe(204);
    let overview = await readPublic(fx.projectIdentifier);
    expect(overview.publicTagline).toBeNull();
    expect(overview.publicOverviewMd).toBe('Body');
    expect(overview.publicTags).toEqual(['a']);

    // The door's other half: a field the caller omits is left where it was.
    expect((await patch(fx.projectIdentifier, { publicTags: ['b', 'c'] })).status).toBe(204);
    overview = await readPublic(fx.projectIdentifier);
    expect(overview.publicTags).toEqual(['b', 'c']);
    expect(overview.publicOverviewMd).toBe('Body');
    expect(overview.publicTagline).toBeNull();
  });

  it('a non-admin is refused by the SERVICE through the door (403), and the public read is unchanged', async () => {
    const fx = await makePublicProjectFixture();
    const outsider = await createTestUser({ email: 'outsider@example.com' });
    getSession.mockResolvedValueOnce({ user: { id: outsider.id } });

    const res = await patch(fx.projectIdentifier, { publicTagline: 'nope' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_PROJECT_ADMIN');

    const overview = await readPublic(fx.projectIdentifier);
    expect(overview.publicTagline).toBeNull();
  });

  it('a field over its cap comes back as a 422 NAMING the field — the arm the room maps to its slot', async () => {
    const fx = await makePublicProjectFixture();
    getSession.mockResolvedValueOnce({ user: { id: fx.ownerId } });

    const res = await patch(fx.projectIdentifier, {
      publicTagline: 'x'.repeat(PUBLIC_TAGLINE_MAX_LENGTH + 1),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; field: string; max: number };
    expect(body.code).toBe('PROJECT_TAGLINE_TOO_LONG');
    expect(body.field).toBe('publicTagline');
    expect(body.max).toBe(PUBLIC_TAGLINE_MAX_LENGTH);

    const overview = await readPublic(fx.projectIdentifier);
    expect(overview.publicTagline).toBeNull();
  });
});
