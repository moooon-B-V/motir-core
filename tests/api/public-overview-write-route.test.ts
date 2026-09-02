import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { runAsCloudBuild } from '../helpers/cloudBuild';

runAsCloudBuild();

// `PATCH /api/projects/{key}/public-overview` (MOTIR-4114 ·
// `public-surface-hosts.md` AMENDMENT 3 row 7) — the door
// `publicProjectsService.setPublicOverview` has been without since MOTIR-3951
// deleted the Server Action that was its only caller.
//
// ⚠️ WHAT THIS ROUTE MUST NOT DO IS GATE. The service is admin-gated twice — it
// refuses a non-admin with `NotProjectAdminError` before any write, and the
// delegate re-runs `assertCanManage` inside the transaction. A route-level admin
// check would be a third copy of a rule that already has two, and a third copy
// is a third thing to drift. So what is asserted here is that the actor is
// PASSED and that the refusal is MAPPED — not that the route decides anything.

const routeSrc = readFileSync(
  join(process.cwd(), 'app/api/projects/[key]/public-overview/route.ts'),
  'utf8',
);

const setPublicOverview = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { setPublicOverview },
}));

const { PATCH } = await import('@/app/api/projects/[key]/public-overview/route');

const params = (key: string) => ({ params: Promise.resolve({ key }) });
const patch = (body: unknown) =>
  new Request('https://app.motir.co/api/projects/PROD/public-overview', {
    method: 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

afterEach(() => vi.clearAllMocks());

describe('PATCH /api/projects/{key}/public-overview', () => {
  it('passes the KEY and the actor to the service and answers 204', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_1' } });
    setPublicOverview.mockResolvedValue(undefined);

    const res = await PATCH(patch({ publicOverviewMd: '# Hello' }), params('PROD'));

    expect(res.status).toBe(204);
    expect(setPublicOverview).toHaveBeenCalledWith('PROD', 'user_1', {
      publicOverviewMd: '# Hello',
    });
  });

  it('is a PARTIAL author — an ABSENT field is not sent, and is therefore untouched', async () => {
    // The service's contract: absent = untouched. Sending `undefined` for a
    // field the caller omitted would be the same thing; sending `null` would
    // CLEAR it. The distinction is the whole reason the body is built by
    // spreading rather than by listing three keys.
    getSession.mockResolvedValue({ user: { id: 'user_1' } });
    setPublicOverview.mockResolvedValue(undefined);

    await PATCH(patch({ publicTagline: 'A tagline' }), params('PROD'));

    expect(setPublicOverview).toHaveBeenCalledWith('PROD', 'user_1', {
      publicTagline: 'A tagline',
    });
  });

  it('a NULL tagline is sent through — clearing is not the same as omitting', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_1' } });
    setPublicOverview.mockResolvedValue(undefined);

    await PATCH(patch({ publicTagline: null }), params('PROD'));

    expect(setPublicOverview).toHaveBeenCalledWith('PROD', 'user_1', { publicTagline: null });
  });

  it('passes a NULL actor rather than short-circuiting — the service owns the refusal', async () => {
    // An anonymous caller never resolves `canManage`, so the service 403s on the
    // same path a non-admin takes. A 401 here would be a second gate with its
    // own opinion about who may edit.
    getSession.mockResolvedValue(null);
    setPublicOverview.mockRejectedValue(new NotProjectAdminError('proj_1'));

    const res = await PATCH(patch({ publicOverviewMd: 'x' }), params('PROD'));

    expect(setPublicOverview).toHaveBeenCalledWith('PROD', null, { publicOverviewMd: 'x' });
    expect(res.status).toBe(403);
  });

  it('maps the service refusals through the SHARED project error mapper', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_1' } });

    setPublicOverview.mockRejectedValueOnce(new NotProjectAdminError('proj_1'));
    expect((await PATCH(patch({ publicTags: ['a'] }), params('PROD'))).status).toBe(403);

    setPublicOverview.mockRejectedValueOnce(new ProjectNotFoundError('PROD'));
    expect((await PATCH(patch({ publicTags: ['a'] }), params('PROD'))).status).toBe(404);
  });

  describe('refuses a malformed field rather than dropping it', () => {
    // The trap this closes: a route that coerced or ignored a wrong-typed value
    // would answer 204 while silently discarding an edit the author believes
    // they made.
    const CASES: Array<[string, unknown]> = [
      ['publicOverviewMd as a number', { publicOverviewMd: 42 }],
      ['publicTagline as an object', { publicTagline: { a: 1 } }],
      ['publicTags as a string', { publicTags: 'design' }],
      ['publicTags containing a non-string', { publicTags: ['design', 7] }],
    ];

    for (const [name, body] of CASES) {
      it(name, async () => {
        getSession.mockResolvedValue({ user: { id: 'user_1' } });

        const res = await PATCH(patch(body), params('PROD'));

        expect(res.status).toBe(400);
        expect(setPublicOverview).not.toHaveBeenCalled();
      });
    }

    it('a body that is not JSON at all', async () => {
      getSession.mockResolvedValue({ user: { id: 'user_1' } });

      const res = await PATCH(
        new Request('https://app.motir.co/api/projects/PROD/public-overview', {
          method: 'PATCH',
          body: 'not json',
        }),
        params('PROD'),
      );

      expect(res.status).toBe(400);
      expect(setPublicOverview).not.toHaveBeenCalled();
    });
  });

  it('is ABSENT off-cloud, before any session read', async () => {
    const previous = process.env['MOTIR_CLOUD'];
    delete process.env['MOTIR_CLOUD'];
    try {
      const res = await PATCH(patch({ publicOverviewMd: 'x' }), params('PROD'));
      expect(res.status).not.toBe(204);
      expect(getSession).not.toHaveBeenCalled();
      expect(setPublicOverview).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previous;
    }
  });

  it('lives OUTSIDE the public contract, deliberately', () => {
    // AMENDMENT 3 makes this affordance ABSENT from motir.co, so no consumer of
    // the public document can call it. Declaring an operation there would
    // document a capability that does not exist for its readers.
    expect(routeSrc).not.toContain('lib/api/public/openapi');
    expect(routeSrc).toContain('AMENDMENT 3 row 7');
  });
});
