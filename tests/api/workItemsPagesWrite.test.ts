import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageArchivedError, PageNotFoundError } from '@/lib/pages';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// The hand link's two routes (Story MOTIR-7567 · MOTIR-9197) with the service
// mocked: `POST /api/work-items/[id]/pages` and
// `DELETE /api/work-items/[id]/pages/[pageId]` — the `pageId` validation, the two
// success shapes, a body's own `source` being ignored, and each typed refusal's
// status and body (naming no page title and no work-item identifier).

const link = vi.fn();
const unlink = vi.fn();
const CTX = { userId: 'u1', workspaceId: 'w1' };

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantWorkspaceContext: async () => ({ ok: true, ctx: CTX }),
}));
vi.mock('@/lib/services/pageLinksService', () => ({
  pageLinksService: {
    linkPageForWorkItem: (...a: unknown[]) => link(...a),
    unlinkPageForWorkItem: (...a: unknown[]) => unlink(...a),
  },
}));

const { POST } = await import('@/app/api/work-items/[id]/pages/route');
const { DELETE } = await import('@/app/api/work-items/[id]/pages/[pageId]/route');

const post = (body: unknown, raw = false) =>
  POST(
    new Request('http://localhost:3000/api/work-items/w1/pages', {
      method: 'POST',
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'w1' }) },
  );
const del = () =>
  DELETE(new Request('http://localhost:3000/api/work-items/w1/pages/p1', { method: 'DELETE' }), {
    params: Promise.resolve({ id: 'w1', pageId: 'p1' }),
  });

beforeEach(() => {
  link.mockReset();
  unlink.mockReset();
});

describe('POST /api/work-items/[id]/pages', () => {
  it('200 with the pair, asking the service for the work item and page only', async () => {
    link.mockResolvedValue({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    const res = await post({ pageId: 'p1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    expect(link).toHaveBeenCalledWith(CTX, { workItemId: 'w1', pageId: 'p1' });
  });

  it('ignores a source in the body: the hand door cannot mint a derived source', async () => {
    link.mockResolvedValue({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    await post({ pageId: 'p1', source: 'mention' });
    expect(link).toHaveBeenCalledWith(CTX, { workItemId: 'w1', pageId: 'p1' });
  });

  it('400 BAD_REQUEST without calling the service for a missing, non-string or empty pageId, or a non-JSON body', async () => {
    for (const res of [
      await post({}),
      await post({ pageId: 7 }),
      await post({ pageId: '' }),
      await post(null),
      await post('not json', true),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    }
    expect(link).not.toHaveBeenCalled();
  });

  it.each([
    ['already linked', new PageLinkAlreadyExistsError('p1', 'w1'), 409, 'PAGE_LINK_ALREADY_LINKED'],
    ['archived', new PageArchivedError('p1'), 409, 'PAGE_ARCHIVED'],
    ['unknown page', new PageNotFoundError('p1'), 404, 'PAGE_NOT_FOUND'],
    ['unknown work item', new WorkItemNotFoundError('w1'), 404, 'WORK_ITEM_NOT_FOUND'],
    ['no capability', new ProjectAccessDeniedError('pr1', 'edit'), 403, 'PROJECT_ACCESS_DENIED'],
  ])('%s → %i', async (_name, err, status, code) => {
    link.mockRejectedValue(err);
    const res = await post({ pageId: 'p1' });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    if (status === 403) expect(JSON.stringify(body)).not.toMatch(/Runbook|MOTIR-/);
  });
});

describe('DELETE /api/work-items/[id]/pages/[pageId]', () => {
  it('204 with no body', async () => {
    unlink.mockResolvedValue({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(unlink).toHaveBeenCalledWith(CTX, { workItemId: 'w1', pageId: 'p1' });
  });

  it.each([
    ['no hand link', new PageLinkNotFoundError('p1', 'w1'), 404, 'PAGE_LINK_NOT_FOUND'],
    ['unknown page', new PageNotFoundError('p1'), 404, 'PAGE_NOT_FOUND'],
    ['unknown work item', new WorkItemNotFoundError('w1'), 404, 'WORK_ITEM_NOT_FOUND'],
    ['no capability', new ProjectAccessDeniedError('pr1', 'edit'), 403, 'PROJECT_ACCESS_DENIED'],
  ])('%s → %i', async (_name, err, status, code) => {
    unlink.mockRejectedValue(err);
    const res = await del();
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });
});
