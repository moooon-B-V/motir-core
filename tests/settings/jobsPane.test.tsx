// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Story MOTIR-4843 · MOTIR-4849 — THE SHARED PANE, and the gates that live in it.
//
// ⚠️ THESE ASSERTIONS USED TO BE `jobRunsFoldIn.test.tsx`'s, and moving them is
// a strengthening rather than a relocation. They are `plan-rules/core.md` gate
// 8's AUDIENCE ARM for the jobs dashboard — §6d's *relocating a surface
// preserves its gate* — and while the reads lived in the fold-in they could only
// be asserted for the fold-in. `JobsPane` is what BOTH doors render now, so one
// set of cases covers the standalone route and the folded-in section together,
// and the two cannot drift apart without this file going red.
//
// The failure this guards is the one that reads as conservative: gating a
// relocated surface on the HOST page's org-admin check instead of the SOURCE
// surface's membership check, which would close the dashboard to exactly the
// smallest customers — the only people who ever see the folded-in state.

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const getMemberRole = vi.fn();
const countDLQ = vi.fn();
const listJobRuns = vi.fn();
const listDLQ = vi.fn();
const listSystemRuns = vi.fn();

vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { getMemberRole: (...a: unknown[]) => getMemberRole(...a) },
}));
vi.mock('@/lib/services/jobsDashboardService', () => ({
  JOBS_PAGE_SIZE: 20,
  jobsDashboardService: {
    countDLQ: (...a: unknown[]) => countDLQ(...a),
    listJobRuns: (...a: unknown[]) => listJobRuns(...a),
    listDLQ: (...a: unknown[]) => listDLQ(...a),
    listSystemRuns: (...a: unknown[]) => listSystemRuns(...a),
  },
}));

// The dashboard is COMPOSED, not redrawn — so this asserts the PROPS the pane
// hands it. Rendering the real one would test MOTIR-1.6.5's component. Where its
// links point is a different claim, with its own file
// (`jobsDashboardBasePath.test.tsx`), which mounts the real component precisely
// because a props assertion cannot see an href.
const dashboardProps = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/jobs/_components/JobsDashboard', () => ({
  JobsDashboard: (props: Record<string, unknown>) => {
    dashboardProps(props);
    return <div data-testid="jobs-dashboard" />;
  },
}));

import {
  JobsPane,
  parseJobsParams,
} from '@/app/(authed)/settings/workspace/jobs/_components/JobsPane';

const WORKSPACE_ID = 'ws1';
const BASE = { userId: 'u1', workspaceId: WORKSPACE_ID, basePath: '/settings/organization' };

function seed({ role = 'member', dlq = 0, runs = 0, dlqRows = 0, systemRuns = 0 } = {}) {
  getMemberRole.mockResolvedValue(role);
  countDLQ.mockResolvedValue(dlq);
  listJobRuns.mockResolvedValue(Array.from({ length: runs }, (_, i) => ({ id: `r${i}` })));
  listDLQ.mockResolvedValue(Array.from({ length: dlqRows }, (_, i) => ({ id: `d${i}` })));
  listSystemRuns.mockResolvedValue(Array.from({ length: systemRuns }, (_, i) => ({ id: `s${i}` })));
}

async function renderPane(
  overrides: Partial<Parameters<typeof JobsPane>[0]> = {},
): Promise<Record<string, unknown>> {
  render(
    await JobsPane({
      ...BASE,
      tab: 'runs',
      status: undefined,
      page: 1,
      showSystemTab: false,
      ...overrides,
    }),
  );
  return dashboardProps.mock.calls.at(-1)![0] as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the pane reads the WORKSPACE, and only ever the workspace', () => {
  it('scopes both reads to the workspace and the actor — never an org-scoped list', async () => {
    seed();
    await renderPane();
    expect(listJobRuns).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: 'u1' }),
    );
    expect(countDLQ).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, userId: 'u1' });
  });

  it('takes no org role in its signature at all', async () => {
    seed();
    await renderPane();
    expect(getMemberRole).toHaveBeenCalledWith('u1', WORKSPACE_ID);
  });
});

describe('each capability keeps the gate it asserts', () => {
  it('the DLQ badge count travels', async () => {
    seed({ dlq: 7 });
    expect((await renderPane())['dlqCount']).toBe(7);
  });

  it('the REPLAY control is present for a workspace OWNER', async () => {
    seed({ role: 'owner' });
    expect((await renderPane())['isOwner']).toBe(true);
  });

  it('the REPLAY control is ABSENT for a non-owner — the gate is not widened', async () => {
    seed({ role: 'member' });
    expect((await renderPane())['isOwner']).toBe(false);
  });

  it('the SYSTEM tab is passed through, never decided here', async () => {
    // The two hosts resolve it from different places — a session on the
    // standalone route, an actor email on the fold-in — so the pane must not
    // form an opinion of its own, or the doors could disagree about who is
    // staff. It is a parameter, and this is what says so.
    seed();
    expect((await renderPane({ showSystemTab: true }))['showSystemTab']).toBe(true);
    cleanup();
    expect((await renderPane({ showSystemTab: false }))['showSystemTab']).toBe(false);
  });
});

describe('the pane fetches the list the TAB names', () => {
  it('the runs tab reads job runs, and hands the dlq an empty list', async () => {
    seed({ runs: 3 });
    const props = await renderPane({ tab: 'runs' });
    expect(props['runs']).toHaveLength(3);
    expect(props['dlq']).toEqual([]);
    expect(listDLQ).not.toHaveBeenCalled();
  });

  it('the dlq tab reads the dead-letter queue, and hands the runs an empty list', async () => {
    // ⚠️ THE TAB THAT COULD NOT BE OPENED AT ALL until MOTIR-4849. The fold-in
    // pinned `activeTab="runs"`, so this branch was unreachable through it —
    // which is why "the DLQ badge shows a count" and "the DLQ can be read" were
    // two different claims, and only the first was true.
    seed({ dlqRows: 4 });
    const props = await renderPane({ tab: 'dlq' });
    expect(props['dlq']).toHaveLength(4);
    expect(props['runs']).toEqual([]);
    expect(listJobRuns).not.toHaveBeenCalled();
  });

  it('the system tab reads the PLATFORM-wide list, with no workspace at all', async () => {
    // These are the runs that belong to no tenant — the nullable `workspaceId`
    // rows. A workspace filter here would silently return nothing.
    seed({ systemRuns: 2 });
    const props = await renderPane({ tab: 'system', showSystemTab: true });
    expect(props['runs']).toHaveLength(2);
    expect(listSystemRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 21, offset: 0 }));
  });
});

describe('paging is a LOOK-AHEAD row, not a count query', () => {
  it('reports hasNext off the extra row, which never reaches the rendered page', async () => {
    seed({ runs: 21 });
    const props = await renderPane();
    expect(props['hasNext']).toBe(true);
    expect(props['runs']).toHaveLength(20);
  });

  it('reports hasNext false at exactly one page', async () => {
    seed({ runs: 20 });
    const props = await renderPane();
    expect(props['hasNext']).toBe(false);
    expect(props['runs']).toHaveLength(20);
  });

  it('offsets by whole pages', async () => {
    seed({ runs: 5 });
    await renderPane({ page: 3 });
    expect(listJobRuns).toHaveBeenCalledWith(expect.objectContaining({ offset: 40, limit: 21 }));
  });
});

describe('parseJobsParams — ONE answer to "which view did they ask for"', () => {
  // ⚠️ SHARED ON PURPOSE. Two doors parsing the same query separately is two
  // answers waiting to disagree, and the disagreement is invisible: each door's
  // own tests pass. The fold-in shipped with NO parsing at all — pinned to the
  // default view — which is the degenerate case of exactly that.
  it('defaults to the runs tab, page 1, no status', () => {
    expect(parseJobsParams({}, false)).toEqual({ tab: 'runs', status: undefined, page: 1 });
  });

  it('reads the three params it knows', () => {
    expect(parseJobsParams({ tab: 'dlq', status: 'failed', page: '4' }, false)).toEqual({
      tab: 'dlq',
      status: 'failed',
      page: 4,
    });
  });

  it('ignores a status it does not recognise, rather than filtering on nonsense', () => {
    expect(parseJobsParams({ status: 'exploded' }, false).status).toBeUndefined();
  });

  it.each([['0'], ['-2'], ['1.5'], ['abc'], [undefined]])('falls back to page 1 for %s', (raw) => {
    expect(parseJobsParams(raw === undefined ? {} : { page: raw }, false).page).toBe(1);
  });

  it('⚠️ coerces `?tab=system` to `runs` for a non-admin — a shared URL must not refuse', () => {
    expect(parseJobsParams({ tab: 'system' }, false).tab).toBe('runs');
    expect(parseJobsParams({ tab: 'system' }, true).tab).toBe('system');
  });
});
