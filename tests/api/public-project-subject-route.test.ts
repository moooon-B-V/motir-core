import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { runAsCloudBuild } from '../helpers/cloudBuild';

// This suite asserts what the public surface SERVES, which is a CLOUD build
// (MOTIR-4034): off-cloud every `app/api/public/*` route is an absent capability.
runAsCloudBuild();

// The public project SUBJECT route (MOTIR-3945) — the endpoint the page's own
// subject never had, while every list beside it did.
//
// ⚠️ WHY THIS IS NOT A REAL-POSTGRES ROUTE TEST, stated rather than left to be
// inferred. The repository's route tests prefer the real database and no mocks,
// and that is right where a route OWNS a query. This route owns none: it is
// `params` → one service call → error mapping, and the service it calls
// (`getOverview`) is the SAME one `app/(public)/p/[identifier]/page.tsx` already
// reads through, exercised by `tests/e2e/cloud-public-project-flow.spec.ts` against a
// real project. Re-seeding a workspace here would test `getOverview` a second
// time and this route not at all. What IS this route's own behaviour — the
// anonymous posture, the 404 mapping, and the promise that its projection is the
// page's — is asserted below, including one source-level guard that no runtime
// test can express.

const routeSrc = readFileSync(
  join(process.cwd(), 'app/api/public/p/[identifier]/route.ts'),
  'utf8',
);

const getOverview = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: { getOverview },
}));

const { GET } = await import('@/app/api/public/p/[identifier]/route');

const params = (identifier: string) => ({ params: Promise.resolve({ identifier }) });
const req = () => new Request('https://app.motir.co/api/public/p/PROD');

afterEach(() => vi.clearAllMocks());

describe('GET /api/public/p/[identifier]', () => {
  it('answers with NO session — an anonymous reader is the point of a public project', async () => {
    getSession.mockResolvedValue(null);
    getOverview.mockResolvedValue({ id: 'p1', identifier: 'PROD', name: 'Prodect' });

    const res = await GET(req(), params('PROD'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: 'p1', identifier: 'PROD', name: 'Prodect' });
    // null actor — the service decides visibility, the route never authorises.
    expect(getOverview).toHaveBeenCalledWith('PROD', null);
  });

  it('passes the viewer through when there IS a session, to personalise and never to gate', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getOverview.mockResolvedValue({ id: 'p1', canManage: true });

    await GET(req(), params('PROD'));

    expect(getOverview).toHaveBeenCalledWith('PROD', 'u1');
  });

  it('maps a non-public or unknown project to 404 with the typed code — no existence leak', async () => {
    getSession.mockResolvedValue(null);
    getOverview.mockRejectedValue(new ProjectNotFoundError('NOPE'));

    const res = await GET(req(), params('NOPE'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ code: new ProjectNotFoundError('NOPE').code });
  });

  it('lets an unexpected error surface rather than reporting it as a missing project', async () => {
    getSession.mockResolvedValue(null);
    getOverview.mockRejectedValue(new Error('the database is on fire'));

    await expect(GET(req(), params('PROD'))).rejects.toThrow('the database is on fire');
  });

  // ── the projection guard ──────────────────────────────────────────────────
  // The card's contract was that this route returns what the PAGE rendered. The
  // page has since moved to motir-marketing (MOTIR-3951 deleted
  // app/(public)/p), so the guard that remains is that the route reaches the
  // service through the same cache() wrapper, not a second projection.
  it('reads the same projection through the cache wrapper', () => {
    expect(routeSrc).toMatch(/publicProjectsService\.getOverview\(/);
    // `getPublicOverview` is the cache() wrapper over the same call.
    const viewerCtx = readFileSync(
      join(process.cwd(), 'lib/publicProjects/viewerContext.ts'),
      'utf8',
    );
    expect(viewerCtx).toMatch(/getPublicOverview[\s\S]*publicProjectsService\.getOverview\(/);
  });

  it('imports no Prisma client — a framework boundary calls a service (the 4-layer rule)', () => {
    expect(routeSrc).not.toMatch(/@prisma\/client|from '@\/lib\/db'/);
  });
});
