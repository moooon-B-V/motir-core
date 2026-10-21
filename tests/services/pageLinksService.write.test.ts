import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageArchivedError, PageNotFoundError } from '@/lib/pages';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// The hand link's write operations (Story MOTIR-7567 · MOTIR-9197) with the
// repositories, the revision recorder, the tenant read and the two access
// asserts mocked: what each operation writes and deletes, the call shapes and
// the `tx` identity they receive, the gate order, the creation-only archive
// asymmetry, and — for every refusal — what it did NOT write. The real-Postgres
// proof of the same seam is the story's integration gate.

const TX = { tx: true } as const;
const ITEM = { id: 'w1', workspaceId: 'ws1', projectId: 'pr1' };
const PAGE = { id: 'p1', projectId: 'pr1', title: 'Runbook', archivedAt: null as Date | null };
const CTX = { userId: 'u1', workspaceId: 'ws1' };

const mocks = vi.hoisted(() => ({
  readWorkItem: vi.fn(),
  withWorkspaceContext: vi.fn(),
  assertCanEdit: vi.fn(),
  assertCanViewPages: vi.fn(),
  findPage: vi.fn(),
  createManual: vi.fn(),
  deleteManual: vi.fn(),
  recordRevision: vi.fn(),
  derived: {
    findDerivedByPage: vi.fn(),
    deleteDerivedByIds: vi.fn(),
    findItemDerivedByWorkItem: vi.fn(),
    deleteItemDerivedByIds: vi.fn(),
    createDerived: vi.fn(),
  },
}));

vi.mock('@/lib/workspaces/tenantRead', () => ({ readWorkItem: mocks.readWorkItem }));
vi.mock('@/lib/workspaces/context', () => ({ withWorkspaceContext: mocks.withWorkspaceContext }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    assertCanEdit: mocks.assertCanEdit,
    assertCanViewPages: mocks.assertCanViewPages,
  },
}));
vi.mock('@/lib/repositories/pageRepository', () => ({
  pageRepository: { findById: mocks.findPage },
}));
vi.mock('@/lib/repositories/pageWorkItemLinkRepository', () => ({
  pageWorkItemLinkRepository: {
    createManual: mocks.createManual,
    deleteManual: mocks.deleteManual,
    ...mocks.derived,
  },
}));
vi.mock('@/lib/services/workItemRevisionsService', () => ({
  workItemRevisionsService: { recordRevision: mocks.recordRevision },
}));

const { pageLinksService } = await import('@/lib/services/pageLinksService');

const link = () => pageLinksService.linkPageForWorkItem(CTX, { workItemId: 'w1', pageId: 'p1' });
const unlink = () =>
  pageLinksService.unlinkPageForWorkItem(CTX, { workItemId: 'w1', pageId: 'p1' });

/** Nothing derived may be touched by a hand-link write. */
function expectNoDerivedWrite() {
  for (const fn of Object.values(mocks.derived)) expect(fn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readWorkItem.mockResolvedValue(ITEM);
  mocks.withWorkspaceContext.mockImplementation(async (_scope, body) => body(TX));
  mocks.assertCanEdit.mockResolvedValue(undefined);
  mocks.assertCanViewPages.mockResolvedValue(undefined);
  mocks.findPage.mockResolvedValue({ ...PAGE });
  mocks.createManual.mockResolvedValue(1);
  mocks.deleteManual.mockResolvedValue(1);
  mocks.recordRevision.mockResolvedValue('rev1');
});

describe('pageLinksService.linkPageForWorkItem', () => {
  it('writes exactly one manual row, ids from the resolved item, and one revision on the same tx', async () => {
    expect(await link()).toEqual({ pageId: 'p1', workItemId: 'w1', source: 'manual' });

    expect(mocks.withWorkspaceContext).toHaveBeenCalledWith(
      { userId: 'u1', workspaceId: 'ws1', projectId: 'pr1' },
      expect.any(Function),
    );
    expect(mocks.createManual).toHaveBeenCalledTimes(1);
    expect(mocks.createManual).toHaveBeenCalledWith(
      { workspaceId: 'ws1', projectId: 'pr1', pageId: 'p1', workItemId: 'w1', createdById: 'u1' },
      TX,
    );
    expect(mocks.recordRevision).toHaveBeenCalledTimes(1);
    expect(mocks.recordRevision).toHaveBeenCalledWith(
      {
        workItemId: 'w1',
        changedById: 'u1',
        changeKind: 'updated',
        diff: { pageLinks: { added: [{ pageId: 'p1', title: 'Runbook' }] } },
      },
      TX,
    );
    // A page that also mentions the item is a different key: only the manual row is written.
    expectNoDerivedWrite();
  });

  it('asserts work_item:edit before page:view, both on the transaction', async () => {
    const order: string[] = [];
    mocks.assertCanEdit.mockImplementation(async () => void order.push('edit'));
    mocks.assertCanViewPages.mockImplementation(async () => void order.push('view'));
    await link();
    expect(order).toEqual(['edit', 'view']);
    expect(mocks.assertCanEdit).toHaveBeenCalledWith('pr1', CTX, TX);
    expect(mocks.assertCanViewPages).toHaveBeenCalledWith('pr1', CTX, TX);
  });

  // The duplicate is decided by `createMany({ skipDuplicates: true })`'s written
  // count over the table's `(page_id, work_item_id, source)` uniqueness with
  // `source: 'manual'` — never by catching a unique violation, which would abort
  // the transaction and the revision with it.
  it('raises already-linked on a written count of 0 and records no revision', async () => {
    mocks.createManual.mockResolvedValue(0);
    await expect(link()).rejects.toBeInstanceOf(PageLinkAlreadyExistsError);
    expect(mocks.recordRevision).not.toHaveBeenCalled();
  });

  it('refuses an archived page, writing no row and no revision', async () => {
    mocks.findPage.mockResolvedValue({ ...PAGE, archivedAt: new Date() });
    await expect(link()).rejects.toBeInstanceOf(PageArchivedError);
    expect(mocks.createManual).not.toHaveBeenCalled();
    expect(mocks.recordRevision).not.toHaveBeenCalled();
  });

  it('refuses a page of another project, or an unknown one, with nothing written', async () => {
    mocks.findPage.mockResolvedValue({ ...PAGE, projectId: 'other' });
    await expect(link()).rejects.toBeInstanceOf(PageNotFoundError);
    mocks.findPage.mockResolvedValue(null);
    await expect(link()).rejects.toBeInstanceOf(PageNotFoundError);
    expect(mocks.createManual).not.toHaveBeenCalled();
    expect(mocks.recordRevision).not.toHaveBeenCalled();
  });

  it('refuses a work item that does not resolve or lives in another workspace before any transaction', async () => {
    mocks.readWorkItem.mockResolvedValueOnce(null);
    await expect(link()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    mocks.readWorkItem.mockResolvedValueOnce({ ...ITEM, workspaceId: 'ws2' });
    await expect(link()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(mocks.withWorkspaceContext).not.toHaveBeenCalled();
    expect(mocks.findPage).not.toHaveBeenCalled();
    expect(mocks.createManual).not.toHaveBeenCalled();
  });

  it('refuses a caller without work_item:edit as edit, writing nothing', async () => {
    mocks.assertCanEdit.mockRejectedValue(new ProjectAccessDeniedError('pr1', 'edit'));
    const err = await link().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    expect(mocks.assertCanViewPages).not.toHaveBeenCalled();
    expect(mocks.createManual).not.toHaveBeenCalled();
  });

  it('refuses a caller holding work_item:edit but not page:view as edit', async () => {
    mocks.assertCanViewPages.mockRejectedValue(new ProjectAccessDeniedError('pr1', 'edit'));
    const err = await link().catch((e: unknown) => e);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    expect(mocks.createManual).not.toHaveBeenCalled();
  });

  it('re-maps a browse denial from either assert to the work item not-found', async () => {
    mocks.assertCanEdit.mockRejectedValueOnce(new ProjectAccessDeniedError('pr1', 'browse'));
    await expect(link()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    mocks.assertCanViewPages.mockRejectedValueOnce(new ProjectAccessDeniedError('pr1', 'browse'));
    await expect(link()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(mocks.createManual).not.toHaveBeenCalled();
  });
});

describe('pageLinksService.unlinkPageForWorkItem', () => {
  it('deletes exactly the manual row and records one removal revision on the same tx', async () => {
    expect(await unlink()).toEqual({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    expect(mocks.deleteManual).toHaveBeenCalledWith('p1', 'w1', TX);
    expect(mocks.recordRevision).toHaveBeenCalledTimes(1);
    expect(mocks.recordRevision).toHaveBeenCalledWith(
      {
        workItemId: 'w1',
        changedById: 'u1',
        changeKind: 'updated',
        diff: { pageLinks: { removed: [{ pageId: 'p1', title: 'Runbook' }] } },
      },
      TX,
    );
    expectNoDerivedWrite();
  });

  it('raises not-found when the pair has no manual row (a mention-only pair), recording nothing', async () => {
    mocks.deleteManual.mockResolvedValue(0);
    await expect(unlink()).rejects.toBeInstanceOf(PageLinkNotFoundError);
    expect(mocks.recordRevision).not.toHaveBeenCalled();
    expectNoDerivedWrite();
  });

  it('removes a hand link on an ARCHIVED page — creation is the only archive refusal', async () => {
    mocks.findPage.mockResolvedValue({ ...PAGE, archivedAt: new Date() });
    expect(await unlink()).toEqual({ pageId: 'p1', workItemId: 'w1', source: 'manual' });
    expect(mocks.recordRevision).toHaveBeenCalledTimes(1);
  });

  it('answers PAGE_LINK_NOT_FOUND, never PAGE_ARCHIVED, for a missing hand link on an archived page', async () => {
    mocks.findPage.mockResolvedValue({ ...PAGE, archivedAt: new Date() });
    mocks.deleteManual.mockResolvedValue(0);
    const err = await unlink().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PageLinkNotFoundError);
    expect(err).not.toBeInstanceOf(PageArchivedError);
  });

  it('refuses a page of another project with nothing deleted', async () => {
    mocks.findPage.mockResolvedValue({ ...PAGE, projectId: 'other' });
    await expect(unlink()).rejects.toBeInstanceOf(PageNotFoundError);
    expect(mocks.deleteManual).not.toHaveBeenCalled();
  });

  it('refuses a stranger and a caller without the capabilities exactly as a link does', async () => {
    mocks.readWorkItem.mockResolvedValueOnce(null);
    await expect(unlink()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    mocks.assertCanEdit.mockRejectedValueOnce(new ProjectAccessDeniedError('pr1', 'browse'));
    await expect(unlink()).rejects.toBeInstanceOf(WorkItemNotFoundError);
    mocks.assertCanViewPages.mockRejectedValueOnce(new ProjectAccessDeniedError('pr1', 'edit'));
    const err = await unlink().catch((e: unknown) => e);
    expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    expect(mocks.deleteManual).not.toHaveBeenCalled();
  });
});
