// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// MOTIR-6025 — `/plans` lists planning CONVERSATIONS, filtered by plan state
// (`design/ai-planning/design-notes.md` Part XIX). The successor of the tabbed
// plan list's page test (MOTIR-3241), in the same Server-Component shape: mock
// the boundary modules, `await PlansPage()`, and assert on the element tree —
// WHICH read the page made, which filter it resolved, which of the two empty
// states it chose, and how a `?session=` landing reaches the list.

const {
  getSession,
  getActiveProject,
  getCapabilities,
  listSessions,
  countSessionsByPlanState,
  getSessionRow,
  roomAccess,
  isMotirAiConfigured,
} = vi.hoisted(() => ({
  roomAccess: vi.fn(),
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
  listSessions: vi.fn(),
  countSessionsByPlanState: vi.fn(),
  getSessionRow: vi.fn(),
  isMotirAiConfigured: vi.fn(),
}));

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/planSessionsService', () => ({
  planSessionsService: { listSessions, countSessionsByPlanState, getSessionRow, roomAccess },
}));
vi.mock('@/app/(authed)/plans/sessionRowView', () => ({
  buildSessionRowViews: async (sessions: { id: string }[]) =>
    sessions.map((s) => ({ id: s.id, title: s.id })),
}));

import PlansPage from '@/app/(authed)/plans/page';
import { SessionsList } from '@/app/(authed)/plans/_components/SessionsList';
import { PlanStatusTabs } from '@/app/(authed)/plans/_components/PlanStatusTabs';
import { planStateFromParam } from '@/lib/planning/planSessionFilter';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { PlanWithAILauncher } from '@/components/planning/PlanWithAILauncher';
import { ErrorState } from '@/components/ui/ErrorState';
import { RoomViewSwitch } from '@/components/rooms/RoomViewSwitch';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme' },
};

const COUNTS = { none: 2, generating: 1, planned: 3, stale: 0, approved: 9, declined: 8 };
const NONE_AT_ALL = { none: 0, generating: 0, planned: 0, stale: 0, approved: 0, declined: 0 };

function row(id: string, status: string | null = 'planned') {
  return { id, latestPlan: status ? { id: `plan_${id}`, status, title: null } : null };
}

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props) return out;
  out.push(el);
  for (const value of Object.values(el.props)) walk(value as ReactNode, out);
  return out;
}

const find = (tree: ReactNode, type: unknown) =>
  walk(tree).filter((el) => el.type === type) as ReactElement<Record<string, unknown>>[];

const render = (params?: Record<string, string>) =>
  PlansPage(params === undefined ? {} : { searchParams: Promise.resolve(params) });

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getCapabilities.mockResolvedValue({ canBrowse: true });
  isMotirAiConfigured.mockReturnValue(true);
  listSessions.mockResolvedValue({ sessions: [row('s_1')], nextCursor: null });
  countSessionsByPlanState.mockResolvedValue(COUNTS);
  getSessionRow.mockResolvedValue(null);
  // One view by default, so the no-switch cases below read as they did; the
  // switch and each reader's faces have their own describe (MOTIR-6334).
  roomAccess.mockResolvedValue({ views: ['project'], canAuthor: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('planStateFromParam — the URL is a place a person can type', () => {
  it('takes each of the six states, `none` included', () => {
    for (const state of ['none', 'generating', 'planned', 'stale', 'approved', 'declined']) {
      expect(planStateFromParam(state)).toBe(state);
    }
  });

  it('falls back to ALL (null) for absent, empty, unknown and malformed values', () => {
    for (const raw of [undefined, null, '', 'nonsense', 'APPROVED', 'planned ', 'all']) {
      expect(planStateFromParam(raw)).toBeNull();
    }
  });
});

describe('/plans reads the filter from the URL', () => {
  it('defaults to ALL with no parameter, and asks the service for every session', async () => {
    const tree = await render();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: null, view: 'project' });
    // Ten rows come from the READ's own default; the page passes no literal.
    expect(listSessions.mock.calls[0]![2]).not.toHaveProperty('limit');
    expect(find(tree, PlanStatusTabs)[0]!.props.value).toBeNull();
    expect(getSessionRow).not.toHaveBeenCalled();
  });

  it('`?planState=none` opens on No plan yet', async () => {
    const tree = await render({ planState: 'none' });

    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: 'none', view: 'project' });
    expect(find(tree, PlanStatusTabs)[0]!.props.value).toBe('none');
    expect(find(tree, SessionsList)[0]!.props.planState).toBe('none');
  });

  it('`?planState=nonsense` falls back to All without throwing', async () => {
    await render({ planState: 'nonsense' });
    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: null, view: 'project' });
  });

  it('the list is KEYED on the view and the filter, so a switch remounts rather than appends', async () => {
    const tree = await render({ planState: 'declined' });
    expect(find(tree, SessionsList)[0]!.key).toBe('project|declined|');
  });

  it('the strip gets the counts, total over the vocabulary', async () => {
    const tree = await render();
    expect(find(tree, PlanStatusTabs)[0]!.props.counts).toEqual(COUNTS);
  });
});

describe('/plans?session=<id> lands on that conversation', () => {
  it('highlights a session already on the first page, without pinning a copy', async () => {
    listSessions.mockResolvedValue({ sessions: [row('s_1'), row('s_2')], nextCursor: null });
    getSessionRow.mockResolvedValue(row('s_2'));

    const tree = await render({ session: 's_2' });
    const list = find(tree, SessionsList)[0]!;

    expect(getSessionRow).toHaveBeenCalledWith('p1', 's_2', expect.anything(), {
      view: 'project',
    });
    expect(list.props.highlightId).toBe('s_2');
    expect((list.props.initialViews as { id: string }[]).map((v) => v.id)).toEqual(['s_1', 's_2']);
  });

  it('PINS a session from further down the list to the top of the first page', async () => {
    getSessionRow.mockResolvedValue(row('s_old', null));

    const tree = await render({ session: 's_old' });
    const list = find(tree, SessionsList)[0]!;

    expect((list.props.initialViews as { id: string }[]).map((v) => v.id)).toEqual([
      's_old',
      's_1',
    ]);
    expect(list.props.highlightId).toBe('s_old');
  });

  it('does not pin a session outside the filter in view', async () => {
    getSessionRow.mockResolvedValue(row('s_old', 'approved'));

    const tree = await render({ planState: 'planned', session: 's_old' });
    const list = find(tree, SessionsList)[0]!;

    expect((list.props.initialViews as { id: string }[]).map((v) => v.id)).toEqual(['s_1']);
    expect(list.props.highlightId).toBe('s_old');
  });

  it('an id that names no session highlights nothing', async () => {
    const tree = await render({ session: 'nope' });
    expect(find(tree, SessionsList)[0]!.props.highlightId).toBeNull();
  });
});

describe('/plans has TWO empty states, and only one offers a fresh start (§19.3a)', () => {
  it('NO conversation at all → the project empty state, its CTA, and NO strip', async () => {
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });
    countSessionsByPlanState.mockResolvedValue(NONE_AT_ALL);

    const tree = await render();

    expect(find(tree, PlanStatusTabs)).toHaveLength(0);
    expect(find(tree, SessionsList)).toHaveLength(0);
    const empty = find(tree, EmptyState);
    expect(empty).toHaveLength(1);
    expect(find(empty[0]!.props.action as ReactNode, PlanWithAILauncher)).toHaveLength(1);
    expect(empty[0]!.props.title).toBe('sessions.emptyTitle');
  });

  it('no CTA on the project empty state when Motir AI is not configured', async () => {
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });
    countSessionsByPlanState.mockResolvedValue(NONE_AT_ALL);
    isMotirAiConfigured.mockReturnValue(false);

    const tree = await render();
    expect(find(tree, EmptyState)[0]!.props.action).toBeUndefined();
  });

  it('conversations elsewhere but NONE in this filter → the strip STAYS and no CTA', async () => {
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });

    const tree = await render({ planState: 'stale' });

    expect(find(tree, PlanStatusTabs)).toHaveLength(1);
    expect(find(tree, SessionsList)).toHaveLength(0);
    const empty = find(tree, EmptyState);
    expect(empty[0]!.props.title).toBe('sessions.filteredEmptyTitle');
    expect(empty[0]!.props.action).toBeUndefined();
    expect(find(tree, PlanWithAILauncher)).toHaveLength(0);
  });
});

describe('/plans is gated on browse', () => {
  it('a member without browse gets NoAccessState and no read', async () => {
    getCapabilities.mockResolvedValue({ canBrowse: false });

    const tree = await render();

    expect(find(tree, NoAccessState)).toHaveLength(1);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('signed out → sign-in', async () => {
    getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('REDIRECT:/sign-in');
  });
});

// ── THE VIEW (Story MOTIR-6179 · MOTIR-6334, design MOTIR-6327) ──────────────
describe('/plans — the Mine / Project view', () => {
  const header = (tree: ReactNode) => find(tree, RoomViewSwitch);

  it('a MEMBER (both views) gets the switch; `?view=mine` asks for Mine, keeps planState, drops session', async () => {
    roomAccess.mockResolvedValue({ views: ['mine', 'project'], canAuthor: true });
    const tree = await render({ view: 'mine', planState: 'planned' });
    const sw = header(tree);
    expect(sw).toHaveLength(1);
    expect(sw[0]!.props.value).toBe('mine');
    expect(sw[0]!.props.drop).toEqual(['session']);
    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: 'planned', view: 'mine' });
    expect(countSessionsByPlanState).toHaveBeenCalledWith('p1', expect.anything(), {
      view: 'mine',
    });
    const list = find(tree, SessionsList)[0]!;
    expect(list.props.view).toBe('mine');
    expect(list.key).toBe('mine|planned|');
  });

  it('a two-view reader on a clean URL lands on Mine when Mine has rows, else Project', async () => {
    roomAccess.mockResolvedValue({ views: ['mine', 'project'], canAuthor: true });
    let tree = await render();
    expect(header(tree)[0]!.props.value).toBe('mine');
    vi.clearAllMocks();
    roomAccess.mockResolvedValue({ views: ['mine', 'project'], canAuthor: true });
    listSessions.mockResolvedValue({ sessions: [row('s_1')], nextCursor: null });
    getSessionRow.mockResolvedValue(null);
    countSessionsByPlanState.mockImplementation(
      async (_p: string, _c: unknown, o: { view: string }) =>
        o.view === 'mine' ? NONE_AT_ALL : COUNTS,
    );
    tree = await render();
    expect(header(tree)[0]!.props.value).toBe('project');
  });

  it('a VIEWER gets every session, NO switch, and no Plan-with-AI CTA even when empty', async () => {
    roomAccess.mockResolvedValue({ views: ['project'], canAuthor: false });
    let tree = await render({ view: 'mine' });
    expect(header(tree)).toHaveLength(0);
    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: null, view: 'project' });
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });
    countSessionsByPlanState.mockResolvedValue(NONE_AT_ALL);
    tree = await render();
    const empty = find(tree, EmptyState)[0]!;
    expect(empty.props.description).toBe('sessions.emptyDescriptionRead');
    expect(empty.props.action).toBeUndefined();
    expect(find(tree, PlanWithAILauncher)).toHaveLength(0);
  });

  it('an AUTHOR without the view key gets Mine alone — `?view=project` is not an error', async () => {
    roomAccess.mockResolvedValue({ views: ['mine'], canAuthor: true });
    const tree = await render({ view: 'project' });
    expect(header(tree)).toHaveLength(0);
    expect(listSessions.mock.calls[0]![2]).toEqual({ planState: null, view: 'mine' });
  });

  it('Mine empty: its own copy; the CTA only for an author, never for a decide-only reader', async () => {
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });
    countSessionsByPlanState.mockResolvedValue(NONE_AT_ALL);
    roomAccess.mockResolvedValue({ views: ['mine'], canAuthor: true });
    let empty = find(await render(), EmptyState)[0]!;
    expect(empty.props.title).toBe('sessions.emptyMineTitle');
    expect(find(empty.props.action as ReactNode, PlanWithAILauncher)).toHaveLength(1);
    roomAccess.mockResolvedValue({ views: ['mine'], canAuthor: false });
    empty = find(await render(), EmptyState)[0]!;
    expect(empty.props.action).toBeUndefined();
  });

  it('a filter empty within Mine points at Mine’s other conversations', async () => {
    roomAccess.mockResolvedValue({ views: ['mine'], canAuthor: true });
    listSessions.mockResolvedValue({ sessions: [], nextCursor: null });
    const empty = find(await render({ planState: 'stale' }), EmptyState)[0]!;
    expect(empty.props.description).toBe('sessions.filteredEmptyDescriptionMine');
  });

  it('a reader with NEITHER the key nor a way to act gets not-found', async () => {
    roomAccess.mockResolvedValue({ views: [], canAuthor: false });
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('a FAILED read renders the ErrorState under the header, the switch staying', async () => {
    roomAccess.mockResolvedValue({ views: ['mine', 'project'], canAuthor: true });
    listSessions.mockRejectedValue(new Error('db down'));
    const tree = await render({ view: 'project' });
    expect(header(tree)).toHaveLength(1);
    expect(find(tree, ErrorState)[0]!.props.title).toBe('sessions.readFailedTitle');
    expect(find(tree, SessionsList)).toHaveLength(0);
  });
});
