// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SprintDto } from '@/lib/dto/sprints';

// `/sprints/[id]/report` — the sprint is a PATH segment, and a path id the page
// cannot show opens the default sprint's report instead of a 404 (Story
// MOTIR-8919). The page is an async Server Component, so it is CALLED; the
// services and the heavy report body are mocked at module level, as
// `runsPage-scope.test.tsx` does.

const redirected = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
const listByProject = vi.fn();
const getSprintReport = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirected(to),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((k: string) => k, { rich: (k: string) => k }),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'usr_1' } }) }));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async () => ({
    userId: 'usr_1',
    workspaceId: 'ws_1',
    projectId: 'prj_1',
    project: { identifier: 'PROD', name: 'Prodect' },
  }),
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: {
    listByProject: (...a: unknown[]) => listByProject(...a),
    getSprintReport: (...a: unknown[]) => getSprintReport(...a),
  },
}));
vi.mock('@/lib/services/workflowsService', () => ({
  workflowsService: { getWorkflow: async () => ({ statuses: [] }) },
}));
vi.mock('@/lib/services/reportsService', () => ({
  reportsService: {
    getVelocity: async () => ({ sprints: [], averageCompleted: 0, statistic: 'story_points' }),
    getSprintCycleGraph: async () => undefined,
  },
}));
vi.mock('@/lib/pages/surfaceTranslation', () => ({ startSurfaceTranslation: () => ({}) }));
vi.mock('@/components/workItems/titleTranslation/SurfaceTitleHost', () => ({
  SurfaceTitleHost: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workItems/titleTranslation/SurfaceTitleTranslation', () => ({
  SurfaceShowOriginalSwitch: () => null,
  SurfaceTitlesNotice: () => null,
}));
vi.mock('@/app/(authed)/backlog/_components/backlogShared', () => ({
  buildStatusByKey: () => ({}),
}));
vi.mock('@/app/(authed)/backlog/_components/SprintReport', () => ({
  SprintReport: ({ sprint }: { sprint: SprintDto }) => (
    <div data-testid="sprint-report" data-sprint={sprint.id} />
  ),
}));
vi.mock('@/app/(authed)/sprints/[id]/report/_components/SprintReportSprintPicker', () => ({
  SprintReportSprintPicker: ({ selectedSprintId }: { selectedSprintId: string }) => (
    <div data-testid="picker" data-selected={selectedSprintId} />
  ),
}));

vi.mock('@/app/(authed)/reports/_components/ReportHelp', () => ({
  ReportHelp: ({ report }: { report: string }) => <div data-testid="help" data-report={report} />,
}));

const { default: SprintReportPage } = await import('@/app/(authed)/sprints/[id]/report/page');

function sprint(id: string, state: SprintDto['state'], sequence: number): SprintDto {
  return { id, name: `Sprint ${sequence}`, state, sequence } as SprintDto;
}

const SPRINTS = [
  sprint('done1', 'complete', 1),
  sprint('done2', 'complete', 2),
  sprint('live', 'active', 3),
  sprint('plan', 'planned', 4),
];

const open = (id: string) => SprintReportPage({ params: Promise.resolve({ id }) });

beforeEach(() => {
  redirected.mockClear();
  listByProject.mockReset();
  getSprintReport.mockReset();
  listByProject.mockResolvedValue(SPRINTS);
  getSprintReport.mockResolvedValue({ any: 'report' });
});
afterEach(() => cleanup());

describe('the Sprint report resolves its sprint from the path', () => {
  it('shows a started sprint of the project and passes it to the picker', async () => {
    render(await open('done2'));
    expect(screen.getByTestId('sprint-report').getAttribute('data-sprint')).toBe('done2');
    expect(screen.getByTestId('picker').getAttribute('data-selected')).toBe('done2');
    // The help text sits under the title, as on every other report.
    expect(screen.getByTestId('help').getAttribute('data-report')).toBe('sprintReport');
    expect(redirected).not.toHaveBeenCalled();
  });

  it.each([
    ['a made-up id', 'not-a-real-id'],
    ['a sprint from another project', 'someone-elses-sprint'],
    ['a planned sprint that never started', 'plan'],
  ])('redirects %s to the active (default) sprint — never a 404', async (_label, id) => {
    await expect(open(id)).rejects.toThrow('NEXT_REDIRECT /sprints/live/report');
  });

  it('defaults to the most recently completed sprint when none is active', async () => {
    listByProject.mockResolvedValue([sprint('a', 'complete', 1), sprint('b', 'complete', 2)]);
    await expect(open('nope')).rejects.toThrow('NEXT_REDIRECT /sprints/b/report');
  });

  it('renders the empty state, not a 404, when no sprint has started', async () => {
    listByProject.mockResolvedValue([sprint('plan', 'planned', 1)]);
    render(await open('plan'));
    expect(screen.getByText('sprintReport.noSprintsTitle')).toBeTruthy();
    expect(redirected).not.toHaveBeenCalled();
  });
});
