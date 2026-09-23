// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-6025 — the Plans session list's two SERVER halves beside the page: the
// row view-model builder, and the load-more action that re-gates browse on every
// streamed page.

const { getActiveProject, getCapabilities, listSessions } = vi.hoisted(() => ({
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
  listSessions: vi.fn(),
}));

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
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProject.mockResolvedValue({ userId: 'u1', workspaceId: 'ws1', projectId: 'p1' });
  getCapabilities.mockResolvedValue({ canBrowse: true });
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
    });
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
  it('streams the next page of the SAME filter, as row views', async () => {
    listSessions.mockResolvedValue({ sessions: [dto()], nextCursor: 'cur_2' });

    const out = await loadMoreSessionsAction('cur_1', 'none');

    expect(listSessions).toHaveBeenCalledWith(
      'p1',
      { userId: 'u1', workspaceId: 'ws1' },
      { cursor: 'cur_1', planState: 'none' },
    );
    expect(out.nextCursor).toBe('cur_2');
    expect(out.views.map((v) => v.id)).toEqual(['s_1']);
  });

  it('streams nothing once signed out', async () => {
    getActiveProject.mockResolvedValue(null);
    expect(await loadMoreSessionsAction('cur_1', null)).toEqual({ views: [], nextCursor: null });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('re-gates browse — access lost mid-scroll streams nothing', async () => {
    getCapabilities.mockResolvedValue({ canBrowse: false });
    expect(await loadMoreSessionsAction('cur_1', null)).toEqual({ views: [], nextCursor: null });
    expect(listSessions).not.toHaveBeenCalled();
  });
});
