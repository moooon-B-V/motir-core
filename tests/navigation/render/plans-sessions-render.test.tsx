// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../../helpers/serverPageHarness';

// MOTIR-6025 — LOAD `/plans` and find its landmark. The page moved from a plan
// list to a SESSION list: a new server builder (`sessionRowView`), a new client
// row that composes the overlay opener, and a filter whose parser is imported
// across the server/client line. This renders the whole page — server body and
// client islands together, under Fizz — so a break at any of those seams fails
// HERE, in this card's own CI, rather than only in the story's E2E.

const { getSession, getActiveProject, getCapabilities } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getCapabilities: vi.fn(),
}));
const { listSessions, countSessionsByPlanState, getSessionRow } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  countSessionsByPlanState: vi.fn(),
  getSessionRow: vi.fn(),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  usePathname: () => '/plans',
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
  getFormatter: async () => ({ relativeTime: () => '12 minutes ago' }),
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/ai/availability', () => ({ isMotirAiConfigured: () => true }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getCapabilities },
}));
vi.mock('@/lib/services/planSessionsService', () => ({
  planSessionsService: {
    listSessions,
    countSessionsByPlanState,
    getSessionRow,
    // MOTIR-6334 — the room's views; one view keeps these renders switch-free.
    roomAccess: async () => ({ views: ['project'], canAuthor: true }),
  },
}));

import PlansPage from '@/app/(authed)/plans/page';

const SESSION = {
  id: 's_1',
  origin: 'conversation',
  targetKeys: ['ACME-12'],
  lastActivityAt: '2026-09-23T00:00:00.000Z',
  startedBy: { id: 'u1', name: 'Mara Lind' },
  firstTurn: 'Split invoicing out of billing',
  latestPlan: null,
  planCount: 0,
};

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  getActiveProject.mockResolvedValue({
    userId: 'u1',
    workspaceId: 'ws1',
    projectId: 'p1',
    project: { identifier: 'ACME', name: 'Acme' },
  });
  getCapabilities.mockResolvedValue({ canBrowse: true });
  listSessions.mockResolvedValue({ sessions: [SESSION], nextCursor: null });
  countSessionsByPlanState.mockResolvedValue({
    none: 1,
    generating: 0,
    planned: 0,
    stale: 0,
    approved: 0,
    declined: 0,
  });
  getSessionRow.mockResolvedValue(null);
});

describe('/plans renders end to end', () => {
  it('shows the conversations list, its filter, and a row that reopens its conversation', async () => {
    const html = await renderToHtml(await PlansPage({}));

    expect(html).toContain('role="list" aria-label="Planning conversations"');
    expect(html).toContain('aria-label="Filter conversations by plan state"');
    expect(html).toContain('Split invoicing out of billing');
    expect(html).toMatch(/href="\/plans\?[^"]*planSession=s_1/);
    expect(html).toContain('No plan yet');
  });
});
