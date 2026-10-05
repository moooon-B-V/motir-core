// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-6025 — the Plans session list's two SERVER halves beside the page: the
// row view-model builder, and the load-more action that re-gates browse on every
// streamed page.

const { getActiveProject, getCapabilities, listSessions, resolveActionReadActor } = vi.hoisted(
  () => ({
    getActiveProject: vi.fn(),
    getCapabilities: vi.fn(),
    listSessions: vi.fn(),
    resolveActionReadActor: vi.fn(),
  }),
);

vi.mock('next-intl/server', () => ({
  getFormatter: async () => ({ relativeTime: (d: Date) => `at ${d.toISOString()}` }),
}));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/planSessionsService', () => ({
  planSessionsService: { listSessions },
}));
vi.mock('@/lib/visitor/readActor', () => ({ resolveActionReadActor }));

import { buildSessionRowViews } from '@/app/(authed)/plans/sessionRowView';
import { loadMoreSessionsAction } from '@/app/(authed)/plans/_actions';
import type { PlanSessionRowDto } from '@/lib/dto/planSessions';

function dto(over: Partial<PlanSessionRowDto> = {}): PlanSessionRowDto {
  return {
    id: 's_1',
    origin: 'conversation',
    targetKeys: ['ACME-1'],
    lastActivityAt: '2026-09-23T00:00:00.000Z',
    startedBy: { id: 'u1', name: 'Mara' },
    firstTurn: 'What was asked',
    latestPlan: { id: 'p_1', status: 'planned', title: 'The plan' },
    planCount: 1,
    seed: null,
    state: 'planned',
    endedAt: null,
    endReason: null,
    endedBy: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProject.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1', projectId: 'p1' });
  getCapabilities.mockResolvedValue({ canBrowse: true });
  resolveActionReadActor.mockResolvedValue({ kind: 'none' });
});

describe('buildSessionRowViews', () => {
  it('titles a row by its first turn, formats its activity, and keeps its plan', async () => {
    const [view] = await buildSessionRowViews([dto()]);
    expect(view).toEqual({
      id: 's_1',
      origin: 'conversation',
      title: 'What was asked',
      targetKeys: ['ACME-1'],
      activeLabel: 'at 2026-09-23T00:00:00.000Z',
      startedByName: 'Mara',
      latestPlan: { id: 'p_1', status: 'planned' },
      planCount: 1,
      seed: null,
    });
  });

  it('passes the seed through untouched (MOTIR-6209)', async () => {
    const seed = {
      cardKey: 'ACME-44',
      gateKind: 'decision_choice',
      origin: 'refusal',
      chosenLabel: null,
    } as const;
    const [view] = await buildSessionRowViews([dto({ seed })]);
    expect(view!.seed).toEqual(seed);
  });

  it('falls back to the latest plan’s title, then to nothing', async () => {
    const [byPlan, bare] = await buildSessionRowViews([
      dto({ firstTurn: null, startedBy: null }),
      dto({ firstTurn: null, latestPlan: null, planCount: 0 }),
    ]);
    expect(byPlan!.title).toBe('The plan');
    expect(byPlan!.startedByName).toBeNull();
    expect(bare!.title).toBe('');
    expect(bare!.latestPlan).toBeNull();
  });
});

describe('loadMoreSessionsAction', () => {
  it('streams the next page of the SAME filter and view, as row views', async () => {
    listSessions.mockResolvedValue({ sessions: [dto()], nextCursor: 'cur_2', scope: 'mine' });

    const out = await loadMoreSessionsAction('cur_1', 'none', 'mine');

    expect(listSessions).toHaveBeenCalledWith(
      'p1',
      { userId: 'u1', workspaceId: 'ws1' },
      { cursor: 'cur_1', planState: 'none', view: 'mine' },
    );
    expect(out).toEqual({
      views: [expect.objectContaining({ id: 's_1' })],
      nextCursor: 'cur_2',
    });
  });

  it('streams nothing once signed out', async () => {
    getActiveProject.mockResolvedValue(null);
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      views: [],
      nextCursor: null,
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('re-gates browse — access lost mid-scroll streams nothing', async () => {
    getCapabilities.mockResolvedValue({ canBrowse: false });
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      views: [],
      nextCursor: null,
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  // MOTIR-6890 — a Visitor's list streams the public project the cookie names.
  it('a Visitor streams the VIEWED project in the Project view, not their active one', async () => {
    const visitorCtx = { project: { id: 'pub' }, actorUserId: 'v1' };
    resolveActionReadActor.mockResolvedValue({ kind: 'visitor', ctx: visitorCtx });
    listSessions.mockResolvedValue({ sessions: [dto()], nextCursor: null, scope: 'project' });

    const out = await loadMoreSessionsAction('cur_1', null, 'mine');

    expect(listSessions).toHaveBeenCalledWith('pub', visitorCtx, {
      cursor: 'cur_1',
      planState: null,
      view: 'project',
    });
    expect(getActiveProject).not.toHaveBeenCalled();
    expect(out).toEqual({ views: [expect.objectContaining({ id: 's_1' })], nextCursor: null });
  });

  it('a Visitor past the read budget gets the rate-limited answer', async () => {
    resolveActionReadActor.mockResolvedValue({ kind: 'limited', response: new Response() });
    expect(await loadMoreSessionsAction('cur_1', null, 'project')).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    expect(listSessions).not.toHaveBeenCalled();
  });
});
