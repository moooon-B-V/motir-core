import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageLevelCursorInvalidError } from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { PageLinkCandidatesDto } from '@/lib/dto/pages';

// `GET /api/pages/link-search` (Story MOTIR-7567 · MOTIR-9204) — the transport
// the route owns, with the service stubbed: 400 for a missing project or a short
// query (the service is not called), 200 with the DTO, the cursor passed through,
// and the shared refusal map for 403 / 404 / `PAGE_CURSOR_INVALID`.

const search = vi.fn();
const ctxRef = { current: { userId: 'u1', workspaceId: 'w1' } as unknown };
const gateRef = { current: null as Record<string, unknown> | null };

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () =>
    gateRef.current ?? { ok: true, ctx: ctxRef.current },
}));
vi.mock('@/lib/services/pagesService', () => ({
  pagesService: { searchPagesForLink: (...args: unknown[]) => search(...args) },
}));

const { GET } = await import('@/app/api/pages/link-search/route');

function call(params: Record<string, string>): Promise<Response> {
  const url = new URL('http://localhost:3000/api/pages/link-search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET(new Request(url));
}

beforeEach(() => {
  gateRef.current = null;
  search.mockReset();
});

describe('GET /api/pages/link-search', () => {
  it('200 with the service DTO, passing the trimmed query and the cursor', async () => {
    const dto: PageLinkCandidatesDto = {
      items: [{ id: 'p1', title: 'Roadmap', place: { folderPath: [], parentPageTitle: null } }],
      nextCursor: 'abc',
    };
    search.mockResolvedValue(dto);
    const res = await call({ projectId: 'proj', q: ' road ', cursor: 'c1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto);
    expect(search).toHaveBeenCalledWith(ctxRef.current, {
      projectId: 'proj',
      q: 'road',
      cursor: 'c1',
    });
  });

  it('passes a null cursor when none is given', async () => {
    search.mockResolvedValue({ items: [], nextCursor: null });
    await call({ projectId: 'proj', q: 'road' });
    expect(search).toHaveBeenCalledWith(ctxRef.current, {
      projectId: 'proj',
      q: 'road',
      cursor: null,
    });
  });

  it('400 BAD_REQUEST without calling the service for a missing project or a short query', async () => {
    const noProject = await call({ q: 'road' });
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).code).toBe('BAD_REQUEST');
    const shortQuery = await call({ projectId: 'proj', q: ' r ' });
    expect(shortQuery.status).toBe(400);
    expect((await shortQuery.json()).code).toBe('BAD_REQUEST');
    expect(search).not.toHaveBeenCalled();
  });

  it('403 for a browser without page:view and 404 for a non-browser', async () => {
    search.mockRejectedValueOnce(new ProjectAccessDeniedError('proj', 'edit'));
    expect((await call({ projectId: 'proj', q: 'road' })).status).toBe(403);
    search.mockRejectedValueOnce(new ProjectAccessDeniedError('proj', 'browse'));
    expect((await call({ projectId: 'proj', q: 'road' })).status).toBe(404);
  });

  it("answers the session gate's own response without calling the service", async () => {
    gateRef.current = { ok: false, response: new Response(null, { status: 401 }) };
    expect((await call({ projectId: 'proj', q: 'road' })).status).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it('400 BAD_REQUEST when `q` is absent altogether', async () => {
    expect((await call({ projectId: 'proj' })).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('400 PAGE_CURSOR_INVALID for a cursor the service refuses', async () => {
    search.mockRejectedValueOnce(new PageLevelCursorInvalidError());
    const res = await call({ projectId: 'proj', q: 'road', cursor: 'junk' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PAGE_CURSOR_INVALID');
  });
});
