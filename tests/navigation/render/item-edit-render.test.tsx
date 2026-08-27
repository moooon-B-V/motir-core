// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, findFirst, renderTree, until } from '../../helpers/serverPageHarness';

// FAMILY 4 of 5 — WORK-ITEM LISTS (Story MOTIR-3440 · Task MOTIR-3568).
//
// `/items/[key]/edit` is the list family's one real diff: MOTIR-3444 put the
// capability read and the assignable-members read in one wave BELOW the gate,
// and left `/items` alone because a boundary above it would hide the toolbar it
// already paints.
//
// Two claims here that `tests/navigation/items-surfaces-arrival.test.ts` cannot
// make, because both are about what RUNS:
//
//   1. the wave is a wave — both reads issued before either settles;
//   2. the 308 for an OLD project key. That branch is reached only by a
//      `WorkItemNotFoundError` from the gate followed by a successful alias
//      resolution, and it is the branch a reader is least likely to exercise by
//      hand: an old bookmark, after a project key change.
//
// `renderTree`, not Fizz: the body is `EditIssueForm`, a client island whose
// markup belongs to its own tests.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getActiveProject } = vi.hoisted(() => ({ getActiveProject: vi.fn() }));
const { getIssueDetail } = vi.hoisted(() => ({ getIssueDetail: vi.fn() }));
const { getCapabilities } = vi.hoisted(() => ({ getCapabilities: vi.fn() }));
const { listMembers } = vi.hoisted(() => ({ listMembers: vi.fn() }));
const { resolveAliasedIssueKey } = vi.hoisted(() => ({ resolveAliasedIssueKey: vi.fn() }));
const { redirect, permanentRedirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  permanentRedirect: vi.fn((path: string) => {
    throw new Error(`PERMANENT_REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
  permanentRedirect,
  notFound,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: { getIssueDetail },
}));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/assignableMembersService', () => ({
  assignableMembersService: { list: listMembers },
}));
vi.mock('@/lib/issues/aliasRedirect', () => ({ resolveAliasedIssueKey }));
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured: () => false }));

import EditIssuePage from '@/app/(authed)/items/[key]/edit/page';
import { EditIssueForm } from '@/app/(authed)/items/[key]/edit/_components/EditIssueForm';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme', accessLevel: 'open' },
};

const DETAIL = {
  item: { id: 'wi1', identifier: 'ACME-7', status: 'todo', archivedAt: null },
  workflow: { statuses: [], transitions: [] },
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  duplicates: [],
  clones: [],
  readiness: { ready: true, openBlockers: [] },
};

const params = (key = 'ACME-7') => ({ params: Promise.resolve({ key }) });

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getIssueDetail.mockResolvedValue(DETAIL);
  getCapabilities.mockResolvedValue({ canEdit: true });
  listMembers.mockResolvedValue([]);
  resolveAliasedIssueKey.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/items/[key]/edit — the gate is a gate, and the two reads below it are ONE WAVE', () => {
  it('issues the members read while the capability read is still open', async () => {
    const caps = deferred<{ canEdit: boolean }>();
    getCapabilities.mockReturnValue(caps.promise);

    const rendered = renderTree(EditIssuePage, params());
    await until(() => getCapabilities.mock.calls.length > 0, {
      label: 'the capability read to be issued',
    });

    expect(listMembers).toHaveBeenCalledTimes(1);

    caps.resolve({ canEdit: true });
    const tree = await rendered;
    expect(findFirst(tree, EditIssueForm)).toBeDefined();
  });

  it('holds BOTH reads until the gate has returned', async () => {
    // `getIssueDetail` decides the 404 and the 308, so nothing may run beside
    // it — the ordering claim the wave above must not be allowed to erode.
    const detail = deferred<typeof DETAIL>();
    getIssueDetail.mockReturnValue(detail.promise);

    const rendered = renderTree(EditIssuePage, params());
    await until(() => getIssueDetail.mock.calls.length > 0, { label: 'the gate read' });

    expect(getCapabilities).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();

    detail.resolve(DETAIL);
    await rendered;
    expect(getCapabilities).toHaveBeenCalledTimes(1);
  });
});

describe('/items/[key]/edit — the branches a source read cannot reach', () => {
  it('308s an OLD project key to the canonical one, without a 404', async () => {
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('PROD-7'));
    resolveAliasedIssueKey.mockResolvedValue('ACME-7');

    await expect(renderTree(EditIssuePage, params('PROD-7'))).rejects.toThrow(
      'PERMANENT_REDIRECT:/items/ACME-7/edit',
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  it('404s when the key resolves to no alias either', async () => {
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('NOPE-1'));

    await expect(renderTree(EditIssuePage, params('NOPE-1'))).rejects.toThrow('NOT_FOUND');
  });

  it('hides a browse denial as the SAME 404, and still tries the alias first', async () => {
    getIssueDetail.mockRejectedValue(new ProjectAccessDeniedError('p1', 'browse'));

    await expect(renderTree(EditIssuePage, params())).rejects.toThrow('NOT_FOUND');
    expect(resolveAliasedIssueKey).toHaveBeenCalledTimes(1);
  });

  it('rethrows anything that is neither', async () => {
    getIssueDetail.mockRejectedValue(new Error('a real failure'));

    await expect(renderTree(EditIssuePage, params())).rejects.toThrow('a real failure');
    expect(resolveAliasedIssueKey).not.toHaveBeenCalled();
  });

  it('bounces a read-only actor back to the detail view', async () => {
    getCapabilities.mockResolvedValue({ canEdit: false });

    await expect(renderTree(EditIssuePage, params())).rejects.toThrow('REDIRECT:/items/ACME-7');
    // The discarded members read is the deliberate trade (MOTIR-3444): the
    // redirect is the rare path, and serialising would charge every successful
    // edit a round trip.
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it('renders the no-project hint rather than crashing, and reads nothing', async () => {
    getActiveProject.mockResolvedValue(null);

    const tree = await renderTree(EditIssuePage, params());

    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(getIssueDetail).not.toHaveBeenCalled();
  });

  it('bounces a signed-out reader before it reads the item', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(EditIssuePage, params())).rejects.toThrow('REDIRECT:/sign-in');
    expect(getIssueDetail).not.toHaveBeenCalled();
  });
});
