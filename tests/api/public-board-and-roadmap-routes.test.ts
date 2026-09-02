import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidRoadmapCursorError } from '@/lib/publicProjects/roadmapCursor';
import { runAsCloudBuild } from '../helpers/cloudBuild';
import { stripSourceComments } from '../helpers/stripSourceComments';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

// The BOARD read and the ROADMAP's first page (MOTIR-4109) — the two tab
// payloads a renderer outside this repository could not fetch.
//
// ⚠️ WHY THESE ARE MOCKED-SERVICE ROUTE TESTS, and not real-Postgres ones:
// MOTIR-3945's subject-route suite states the rule and it applies unchanged.
// Neither route owns a query. `getBoard` and `getRoadmap` are the SAME service
// methods the deleted pages read through, and both already have real-database
// service tests (`tests/publicProjects/`). Re-seeding here would test the
// service twice and the routes not at all. What is the ROUTES' own behaviour —
// the arm selection, the anonymous posture, the 404 mapping, and the promise
// that the shipped pagination contract did not move — is what is asserted.

const boardSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/board/route.ts'),
  'utf8',
);
const roadmapSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/roadmap/route.ts'),
  'utf8',
);

const getBoard = vi.hoisted(() => vi.fn());
const getRoadmap = vi.hoisted(() => vi.fn());
const getRoadmapColumn = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getBoard, getRoadmap, getRoadmapColumn },
}));

const { GET: boardGET } = await import('@/app/api/public/p/[identifier]/board/route');
const { GET: roadmapGET } = await import('@/app/api/public/p/[identifier]/roadmap/route');

const params = (identifier: string) => ({ params: Promise.resolve({ identifier }) });
const req = (path: string) => new Request(`https://app.motir.co${path}`);

const board = {
  boardId: 'board_1',
  name: 'Delivery',
  columns: [{ id: 'col_1', name: 'To do', statusKeys: ['todo'], cards: [], totalCount: 0 }],
  cap: 200,
  truncated: false,
};
const roadmap = { columns: [{ key: 'planned', totalCount: 0, cards: [], nextCursor: null }] };
const columnPage = { bucket: 'planned', cards: [], nextCursor: null };

afterEach(() => vi.clearAllMocks());

describe('GET /api/public/p/{identifier}/board', () => {
  it('answers 200 with the board for an ANONYMOUS caller', async () => {
    getSession.mockResolvedValue(null);
    getBoard.mockResolvedValue(board);

    const res = await boardGET(req('/api/public/p/PROD/board'), params('PROD'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(board);
    // The session is read only to PERSONALISE, so anonymously the service is
    // called with a null actor rather than not called at all.
    expect(getBoard).toHaveBeenCalledWith('PROD', null);
  });

  it('passes the session user through when there IS one — viewer-awareness, not authorisation', async () => {
    getSession.mockResolvedValue({ user: { id: 'user_9' } });
    getBoard.mockResolvedValue(board);

    await boardGET(req('/api/public/p/PROD/board'), params('PROD'));

    expect(getBoard).toHaveBeenCalledWith('PROD', 'user_9');
  });

  it('maps ProjectNotFoundError to 404 with a code and NOTHING else — no existence leak', async () => {
    getSession.mockResolvedValue(null);
    getBoard.mockRejectedValue(new ProjectNotFoundError('NOPE'));

    const res = await boardGET(req('/api/public/p/NOPE/board'), params('NOPE'));

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['code']);
    // The body must not distinguish "no such project" from "not public" — the
    // service raises the same error for both and the route must not widen it.
    expect(JSON.stringify(body)).not.toContain('NOPE');
  });

  it('lets an unexpected error THROW rather than answering 404', async () => {
    getSession.mockResolvedValue(null);
    getBoard.mockRejectedValue(new Error('the database fell over'));

    await expect(boardGET(req('/api/public/p/PROD/board'), params('PROD'))).rejects.toThrow(
      'the database fell over',
    );
  });

  it('calls the capability gate BEFORE any session read — a source-level guard', () => {
    // Runtime cannot express "first": with MOTIR_CLOUD set the gate returns null
    // and the ordering is invisible. The gate exists so that off-cloud the
    // surface is ABSENT, and a session read before it would touch auth on a
    // build that has no public surface at all.
    const gateAt = boardSrc.indexOf('publicSurfaceUnavailable()');
    const sessionAt = boardSrc.indexOf('await getSession()');
    expect(gateAt).toBeGreaterThan(-1);
    expect(sessionAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(sessionAt);
  });

  it('contains no business logic — gate, session, ONE service call, error mapping', () => {
    // The 4-layer rule, asserted rather than asked for in review: the route may
    // reach the service exactly once and may not reach Prisma or a repository.
    // Comments are stripped first — this route's own header NAMES the service,
    // and a guard that counts prose is a guard that discourages writing it.
    const code = stripSourceComments(boardSrc);
    expect(code.match(/publicProjectsService\./g)).toHaveLength(1);
    expect(code).not.toMatch(/@\/lib\/db|prisma|Repository/);
  });
});

describe('GET /api/public/p/{identifier}/roadmap — arm 1, the whole tab (new)', () => {
  it('answers 200 with the full roadmap when NEITHER bucket nor cursor is given', async () => {
    getSession.mockResolvedValue(null);
    getRoadmap.mockResolvedValue(roadmap);

    const res = await roadmapGET(req('/api/public/p/PROD/roadmap'), params('PROD'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(roadmap);
    expect(getRoadmap).toHaveBeenCalledWith('PROD', null);
    expect(getRoadmapColumn).not.toHaveBeenCalled();
  });

  it('maps ProjectNotFoundError to 404 on this arm too', async () => {
    getSession.mockResolvedValue(null);
    getRoadmap.mockRejectedValue(new ProjectNotFoundError('NOPE'));

    const res = await roadmapGET(req('/api/public/p/NOPE/roadmap'), params('NOPE'));

    expect(res.status).toBe(404);
    expect(Object.keys((await res.json()) as object)).toEqual(['code']);
  });
});

describe('GET /api/public/p/{identifier}/roadmap — arm 2 is UNCHANGED (the regression pin)', () => {
  // AMENDMENT 1 §D forbids changing the status an existing condition returns.
  // Every request below has a defined answer on origin/main, and each one must
  // still get exactly that answer — this block is the pin, not a formality.

  it('bucket + cursor still pages the column', async () => {
    getSession.mockResolvedValue(null);
    getRoadmapColumn.mockResolvedValue(columnPage);

    const res = await roadmapGET(
      req('/api/public/p/PROD/roadmap?bucket=planned&cursor=abc'),
      params('PROD'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(columnPage);
    expect(getRoadmapColumn).toHaveBeenCalledWith('PROD', null, 'planned', 'abc');
    expect(getRoadmap).not.toHaveBeenCalled();
  });

  it('an UNKNOWN bucket is still 400 INVALID_ROADMAP_BUCKET', async () => {
    getSession.mockResolvedValue(null);

    const res = await roadmapGET(
      req('/api/public/p/PROD/roadmap?bucket=nonsense&cursor=abc'),
      params('PROD'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_ROADMAP_BUCKET' });
    expect(getRoadmap).not.toHaveBeenCalled();
  });

  it('a bucket with NO cursor is still 400 MISSING_ROADMAP_CURSOR — not the whole tab', async () => {
    // The arm that would have been easiest to get wrong. A "cursor is optional
    // now" reading answers 200 here and silently restarts the pager at the top.
    getSession.mockResolvedValue(null);

    const res = await roadmapGET(req('/api/public/p/PROD/roadmap?bucket=planned'), params('PROD'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'MISSING_ROADMAP_CURSOR' });
    expect(getRoadmap).not.toHaveBeenCalled();
  });

  it('a cursor with NO bucket is still 400 INVALID_ROADMAP_BUCKET — not the whole tab', async () => {
    getSession.mockResolvedValue(null);

    const res = await roadmapGET(req('/api/public/p/PROD/roadmap?cursor=abc'), params('PROD'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_ROADMAP_BUCKET' });
    expect(getRoadmap).not.toHaveBeenCalled();
  });

  it('an empty-string bucket is still refused — a blank is not "absent"', async () => {
    getSession.mockResolvedValue(null);

    const res = await roadmapGET(req('/api/public/p/PROD/roadmap?bucket=&cursor='), params('PROD'));

    expect(res.status).toBe(400);
    expect(getRoadmap).not.toHaveBeenCalled();
  });

  it('a MALFORMED cursor is still refused by the decoder, as 400', async () => {
    getSession.mockResolvedValue(null);
    getRoadmapColumn.mockRejectedValue(new InvalidRoadmapCursorError());

    const res = await roadmapGET(
      req('/api/public/p/PROD/roadmap?bucket=planned&cursor=%%%'),
      params('PROD'),
    );

    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()) as object)).toEqual(['code']);
  });

  it('calls the capability gate BEFORE any session read', () => {
    const gateAt = roadmapSrc.indexOf('publicSurfaceUnavailable()');
    const sessionAt = roadmapSrc.indexOf('await getSession()');
    expect(gateAt).toBeLessThan(sessionAt);
  });
});
