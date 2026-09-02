import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicWorkItemNotFoundError } from '@/lib/publicProjects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { stripSourceComments } from '../helpers/stripSourceComments';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

// The two DETAIL reads (MOTIR-4110) — one work item, one feature request.
//
// ⚠️ THE ONE THING THESE ROUTES CAN GET WRONG ON THEIR OWN is the IDENTIFIER
// they hand the service, and it is what most of this suite is about. Both
// services take the target's FULL work-item identifier (`ACME-42`); the URL
// segment carrying it is named `key`, and the DTO field of that name is the bare
// NUMBER. A route that reconciled those two — parsing the number out, or
// rebuilding `${identifier}-${key}` — would work on every fixture anyone would
// think to write and break on a project key containing a dash. So the
// pass-through is asserted directly, with a dashed key as the case that
// distinguishes it.
//
// Everything else these routes do belongs to the service, which has its own
// real-database tests (`tests/publicProjects/publicWorkItemDetail.test.ts`,
// `publicRequestDetail.test.ts`) — MOTIR-3945's rule, unchanged.

const itemSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/items/[key]/route.ts'),
  'utf8',
);
const requestSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/requests/[requestKey]/route.ts'),
  'utf8',
);

const getWorkItemDetail = vi.hoisted(() => vi.fn());
const getRequestDetail = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getWorkItemDetail, getRequestDetail },
}));

const { GET: itemGET } = await import('@/app/api/public/p/[identifier]/items/[key]/route');
const { GET: requestGET } =
  await import('@/app/api/public/p/[identifier]/requests/[requestKey]/route');

const itemParams = (identifier: string, key: string) => ({
  params: Promise.resolve({ identifier, key }),
});
const requestParams = (identifier: string, requestKey: string) => ({
  params: Promise.resolve({ identifier, requestKey }),
});
const req = (path: string) => new Request(`https://app.motir.co${path}`);

const detail = { id: 'wi_1', identifier: 'PROD-42', key: 42, title: 'A thing' };

afterEach(() => vi.clearAllMocks());

describe('GET /api/public/p/{identifier}/items/{key}', () => {
  it('answers 200 for an ANONYMOUS caller and passes a null actor', async () => {
    getSession.mockResolvedValue(null);
    getWorkItemDetail.mockResolvedValue(detail);

    const res = await itemGET(
      req('/api/public/p/PROD/items/PROD-42'),
      itemParams('PROD', 'PROD-42'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(getWorkItemDetail).toHaveBeenCalledWith('PROD', 'PROD-42', null);
  });

  it('passes the segment through VERBATIM — a project key with a DASH still resolves', async () => {
    // The case that separates a pass-through from a reconstruction. Rebuilding
    // `${identifier}-${key}` or parsing a number out of the segment both produce
    // the right answer for `PROD-42` and the wrong one here.
    getSession.mockResolvedValue(null);
    getWorkItemDetail.mockResolvedValue(detail);

    await itemGET(
      req('/api/public/p/OPEN-CORE/items/OPEN-CORE-7'),
      itemParams('OPEN-CORE', 'OPEN-CORE-7'),
    );

    expect(getWorkItemDetail).toHaveBeenCalledWith('OPEN-CORE', 'OPEN-CORE-7', null);
  });

  it('personalises with the session user when there is one', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_3' } });
    getWorkItemDetail.mockResolvedValue(detail);

    await itemGET(req('/api/public/p/PROD/items/PROD-42'), itemParams('PROD', 'PROD-42'));

    expect(getWorkItemDetail).toHaveBeenCalledWith('PROD', 'PROD-42', 'user_3');
  });

  it('answers 404 PROJECT_NOT_FOUND when the PROJECT is not public', async () => {
    getSession.mockResolvedValue(null);
    getWorkItemDetail.mockRejectedValue(new ProjectNotFoundError('PROD'));

    const res = await itemGET(
      req('/api/public/p/PROD/items/PROD-42'),
      itemParams('PROD', 'PROD-42'),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'PROJECT_NOT_FOUND' });
  });

  it('answers 404 PUBLIC_WORK_ITEM_NOT_FOUND for the item half, with a BARE body', async () => {
    // The four item-side conditions — unknown, cross-project, archived, triage,
    // epic-privacy-hidden — all arrive as this one error, and the response must
    // carry nothing that tells them apart or echoes what was asked for.
    getSession.mockResolvedValue(null);
    getWorkItemDetail.mockRejectedValue(new PublicWorkItemNotFoundError('PROD-999'));

    const res = await itemGET(
      req('/api/public/p/PROD/items/PROD-999'),
      itemParams('PROD', 'PROD-999'),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['code']);
    expect(body['code']).toBe('PUBLIC_WORK_ITEM_NOT_FOUND');
    expect(JSON.stringify(body)).not.toContain('PROD-999');
  });

  it('lets an unexpected error THROW rather than answering 404', async () => {
    getSession.mockResolvedValue(null);
    getWorkItemDetail.mockRejectedValue(new Error('the database fell over'));

    await expect(
      itemGET(req('/api/public/p/PROD/items/PROD-42'), itemParams('PROD', 'PROD-42')),
    ).rejects.toThrow('the database fell over');
  });

  it('gates before the session read, and holds no business logic', () => {
    const code = stripSourceComments(itemSrc);
    expect(itemSrc.indexOf('publicSurfaceUnavailable()')).toBeLessThan(
      itemSrc.indexOf('await getSession()'),
    );
    expect(code.match(/publicProjectsService\./g)).toHaveLength(1);
    expect(code).not.toMatch(/@\/lib\/db|prisma|Repository/);
  });
});

describe('GET /api/public/p/{identifier}/requests/{requestKey}', () => {
  it('answers 200 for an ANONYMOUS caller and passes a null actor', async () => {
    getSession.mockResolvedValue(null);
    getRequestDetail.mockResolvedValue(detail);

    const res = await requestGET(
      req('/api/public/p/PROD/requests/PROD-7'),
      requestParams('PROD', 'PROD-7'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(getRequestDetail).toHaveBeenCalledWith('PROD', 'PROD-7', null);
  });

  it('passes the segment through VERBATIM — a dashed project key again', async () => {
    getSession.mockResolvedValue(null);
    getRequestDetail.mockResolvedValue(detail);

    await requestGET(
      req('/api/public/p/OPEN-CORE/requests/OPEN-CORE-3'),
      requestParams('OPEN-CORE', 'OPEN-CORE-3'),
    );

    expect(getRequestDetail).toHaveBeenCalledWith('OPEN-CORE', 'OPEN-CORE-3', null);
  });

  it('personalises `voted` by passing the session user', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_4' } });
    getRequestDetail.mockResolvedValue(detail);

    await requestGET(req('/api/public/p/PROD/requests/PROD-7'), requestParams('PROD', 'PROD-7'));

    expect(getRequestDetail).toHaveBeenCalledWith('PROD', 'PROD-7', 'user_4');
  });

  it('answers 404 for both halves — the project and the request', async () => {
    getSession.mockResolvedValue(null);

    getRequestDetail.mockRejectedValueOnce(new ProjectNotFoundError('PROD'));
    const a = await requestGET(
      req('/api/public/p/PROD/requests/PROD-7'),
      requestParams('PROD', 'PROD-7'),
    );
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual({ code: 'PROJECT_NOT_FOUND' });

    getRequestDetail.mockRejectedValueOnce(new PublicRequestNotFoundError('PROD-999'));
    const b = await requestGET(
      req('/api/public/p/PROD/requests/PROD-999'),
      requestParams('PROD', 'PROD-999'),
    );
    expect(b.status).toBe(404);
    expect(await b.json()).toEqual({ code: 'PUBLIC_REQUEST_NOT_FOUND' });
  });

  it('lets an unexpected error THROW rather than answering 404', async () => {
    getSession.mockResolvedValue(null);
    getRequestDetail.mockRejectedValue(new Error('the database fell over'));

    await expect(
      requestGET(req('/api/public/p/PROD/requests/PROD-7'), requestParams('PROD', 'PROD-7')),
    ).rejects.toThrow('the database fell over');
  });

  it('is a READ — it exports no write verb and touches neither request WRITE route', () => {
    // Comments stripped: the route's header DISCUSSES the write routes at
    // length — which identifier they take and why this one differs — and a
    // guard that counts prose is a guard that punishes explaining yourself.
    const code = stripSourceComments(requestSrc);
    expect(code).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)/);
    expect(code).not.toContain('public-requests');
    expect(code.match(/publicProjectsService\./g)).toHaveLength(1);
  });

  it('gates before the session read', () => {
    expect(requestSrc.indexOf('publicSurfaceUnavailable()')).toBeLessThan(
      requestSrc.indexOf('await getSession()'),
    );
  });
});
