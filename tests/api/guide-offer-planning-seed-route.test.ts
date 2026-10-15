import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';

// MOTIR-8692 — `GET /api/ai/guide/offer/[turnId]/planning-seed`, the HTTP half only:
// the no-project arm, the 2FA hold, the ONE service call and the one 404. The
// service's own cases run against real Postgres in
// `tests/integration/planning/guideOfferSeedRead.test.ts`.

const active = { current: null as ProjectContext | null };
const hold = { current: null as Response | null };
const getGuidePlanningSeed = vi.fn();

vi.mock('@/lib/projects', () => ({ getActiveProject: async () => active.current }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({
  refuseIfNonCompliant: async () => hold.current,
}));
vi.mock('@/lib/services/planningSeedService', () => ({
  planningSeedService: { getGuidePlanningSeed: (...a: unknown[]) => getGuidePlanningSeed(...a) },
}));

const { GET } = await import('@/app/api/ai/guide/offer/[turnId]/planning-seed/route');

const call = (turnId: string) =>
  GET(new Request(`http://localhost:3000/api/ai/guide/offer/${turnId}/planning-seed`), {
    params: Promise.resolve({ turnId }),
  });

beforeEach(() => {
  getGuidePlanningSeed.mockReset();
  active.current = { userId: 'u1', workspaceId: 'w1', projectId: 'p1' } as ProjectContext;
  hold.current = null;
});

describe('GET /api/ai/guide/offer/[turnId]/planning-seed', () => {
  it('answers 401 UNAUTHENTICATED with no active project, calling nothing', async () => {
    active.current = null;
    const res = await call('t1');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(getGuidePlanningSeed).not.toHaveBeenCalled();
  });

  it('returns the 2FA hold as is, calling nothing', async () => {
    hold.current = new Response('hold', { status: 403 });
    const res = await call('t1');
    expect(res.status).toBe(403);
    expect(getGuidePlanningSeed).not.toHaveBeenCalled();
  });

  it('answers 200 with the seed, no-store, from ONE service call', async () => {
    const seed = { source: 'guide', guideTurnId: 't1', firstTurn: 'Re-plan.' };
    getGuidePlanningSeed.mockResolvedValue(seed);
    const res = await call('t1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ seed });
    expect(getGuidePlanningSeed).toHaveBeenCalledTimes(1);
    expect(getGuidePlanningSeed).toHaveBeenCalledWith('t1', active.current);
  });

  it('answers the one 404 body, no-store, for every "nothing here for you"', async () => {
    getGuidePlanningSeed.mockRejectedValue(new PlanningSeedNotFoundError());
    const res = await call('t1');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('rethrows a real fault', async () => {
    getGuidePlanningSeed.mockRejectedValue(new Error('boom'));
    await expect(call('t1')).rejects.toThrow('boom');
  });
});
