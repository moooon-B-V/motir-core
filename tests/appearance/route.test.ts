import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';

// Transport tests for /api/appearance-preference's `fontPicks` arm (MOTIR-7894):
// the shape checks the route owns (400), the membership check the service owns
// (422), and the round trip through GET. The compliance gate is the one stub (a
// route test has no cookie jar); the service and Postgres are the shipped path.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { GET, PATCH } = await import('@/app/api/appearance-preference/route');
const { createTestUser } = await import('../fixtures');

function signInAs(user: { id: string; email: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
}

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost:3000/api/appearance-preference', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('PATCH /api/appearance-preference — fontPicks', () => {
  it('stores a pick and GET returns it', async () => {
    signInAs(await createTestUser());

    const res = await patch({ fontPicks: { ja: 'm-plus-rounded-1c' } });
    expect(res.status).toBe(200);
    expect((await res.json()).preference.fontPicks).toEqual({ ja: 'm-plus-rounded-1c' });

    const read = await GET();
    expect((await read.json()).preference.fontPicks).toEqual({ ja: 'm-plus-rounded-1c' });
  });

  it('clears a pick with null', async () => {
    signInAs(await createTestUser());
    await patch({ fontPicks: { ko: 'nanum-gothic' } });

    const res = await patch({ fontPicks: { ko: null } });

    expect(res.status).toBe(200);
    expect((await res.json()).preference.fontPicks).toEqual({});
  });

  it.each([
    ['not an object', { fontPicks: 'm-plus-rounded-1c' }],
    ['an array', { fontPicks: ['m-plus-rounded-1c'] }],
    ['an unknown locale', { fontPicks: { xx: 'noto-sans-jp' } }],
    ['a non-string value', { fontPicks: { ja: 3 } }],
  ])('refuses fontPicks that is %s with 400', async (_label, body) => {
    signInAs(await createTestUser());

    const res = await patch(body);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
  });

  it('refuses a member of another locale with 422 and stores nothing', async () => {
    const user = await createTestUser();
    signInAs(user);

    const res = await patch({ fontPicks: { ja: 'noto-sans-kr' } });

    expect(res.status).toBe(422);
    expect(await db.userAppearancePreference.count({ where: { userId: user.id } })).toBe(0);
  });
});
