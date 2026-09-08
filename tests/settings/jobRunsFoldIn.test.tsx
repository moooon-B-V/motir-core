// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Story MOTIR-4843 · MOTIR-4861 — the `Job runs` FOLD-IN, and the four gates it
// owes.
//
// ⚠️ THIS IS THE AUDIENCE ARM, NOT A RENDER SMOKE TEST. `plan-rules/core.md`
// gate 8: a MOVE claims that everyone who could reach the source can reach the
// destination, and that claim lives nowhere in the criteria. §6d puts it
// concretely — *a hidden tier may not remove a capability … relocating a surface
// preserves its gate.*
//
// So each capability is asserted SEPARATELY. A section that renders is not
// evidence that its gates travelled with it, and the failure this guards is the
// one that reads as conservative: copying the HOST page's org-admin gate instead
// of the SOURCE surface's membership gate, which would close the dashboard to
// exactly the smallest customers — the only people who ever see the folded-in
// state. That is MOTIR-3500's original defect one surface over.

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const getMemberRole = vi.fn();
const countDLQ = vi.fn();
const listJobRuns = vi.fn();

vi.mock('@/lib/services/workspacesService', () => ({
  workspacesService: { getMemberRole: (...a: unknown[]) => getMemberRole(...a) },
}));
vi.mock('@/lib/services/jobsDashboardService', () => ({
  JOBS_PAGE_SIZE: 20,
  jobsDashboardService: {
    countDLQ: (...a: unknown[]) => countDLQ(...a),
    listJobRuns: (...a: unknown[]) => listJobRuns(...a),
  },
}));

// The dashboard is COMPOSED, not redrawn — so the test asserts the PROPS the
// section hands it. Rendering the real one would test MOTIR-1.6.5's component,
// not this card's gates.
const dashboardProps = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/jobs/_components/JobsDashboard', () => ({
  JobsDashboard: (props: Record<string, unknown>) => {
    dashboardProps(props);
    return <div data-testid="jobs-dashboard" />;
  },
}));

import { JobRunsFoldInSection } from '@/app/(authed)/settings/organization/_components/JobRunsFoldInSection';

const WORKSPACE_ID = 'ws1';
const MEMBER = { workspaceId: WORKSPACE_ID, actorUserId: 'u1', actorEmail: 'member@example.com' };

async function renderSection(props: Parameters<typeof JobRunsFoldInSection>[0]) {
  render(await JobRunsFoldInSection(props));
  return dashboardProps.mock.calls.at(-1)![0] as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete process.env['PLATFORM_ADMIN_EMAIL'];
});

function seed({ role = 'member', dlq = 0, runs = 0 } = {}) {
  getMemberRole.mockResolvedValue(role);
  countDLQ.mockResolvedValue(dlq);
  listJobRuns.mockResolvedValue(Array.from({ length: runs }, (_, i) => ({ id: `r${i}` })));
}

describe('the Job runs fold-in — it renders for a WORKSPACE MEMBER', () => {
  it('renders the dashboard for a plain member, with no org role anywhere in its inputs', async () => {
    seed();
    await renderSection(MEMBER);
    expect(screen.getByTestId('jobs-dashboard')).toBeTruthy();
    // The section takes a workspace id, a user id and an email. There is no org
    // role in its signature at all — which is the structural half of §6d here.
    expect(getMemberRole).toHaveBeenCalledWith('u1', WORKSPACE_ID);
  });

  it('reads the WORKSPACE-scoped job runs, not an org-scoped list', async () => {
    seed();
    await renderSection(MEMBER);
    expect(listJobRuns).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: 'u1' }),
    );
    expect(countDLQ).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, userId: 'u1' });
  });
});

describe('the Job runs fold-in — each capability keeps the gate it asserts', () => {
  it('the DLQ badge count travels', async () => {
    seed({ dlq: 7 });
    const props = await renderSection(MEMBER);
    expect(props['dlqCount']).toBe(7);
  });

  it('the REPLAY control is present for a workspace OWNER', async () => {
    seed({ role: 'owner' });
    const props = await renderSection(MEMBER);
    expect(props['isOwner']).toBe(true);
  });

  it('the REPLAY control is ABSENT for a non-owner — the gate is not widened by the move', async () => {
    seed({ role: 'member' });
    const props = await renderSection(MEMBER);
    expect(props['isOwner']).toBe(false);
  });

  it('the SYSTEM tab is present only when the request email matches PLATFORM_ADMIN_EMAIL', async () => {
    process.env['PLATFORM_ADMIN_EMAIL'] = 'staff@motir.co';
    seed();
    const staff = await renderSection({ ...MEMBER, actorEmail: 'staff@motir.co' });
    expect(staff['showSystemTab']).toBe(true);
  });

  it('the SYSTEM tab is ABSENT for everyone else, and when the env var is unset', async () => {
    process.env['PLATFORM_ADMIN_EMAIL'] = 'staff@motir.co';
    seed();
    expect((await renderSection(MEMBER))['showSystemTab']).toBe(false);
    cleanup();
    delete process.env['PLATFORM_ADMIN_EMAIL'];
    seed();
    // ⚠️ With no admin email configured NOBODY sees it — not everybody. An
    // `email === undefined` comparison would open it to any user whose email is
    // missing, which is why the source guards on `Boolean(adminEmail)` first.
    expect((await renderSection({ ...MEMBER, actorEmail: '' }))['showSystemTab']).toBe(false);
  });
});

describe('the Job runs fold-in — it composes the dashboard rather than redrawing it', () => {
  it('hands it the default view: the first page of runs, and an empty DLQ list', async () => {
    seed({ runs: 3 });
    const props = await renderSection(MEMBER);
    expect(props['activeTab']).toBe('runs');
    expect(props['page']).toBe(1);
    expect(props['dlq']).toEqual([]);
    expect(props['runs']).toHaveLength(3);
  });

  it('reports hasNext off the LOOK-AHEAD row rather than a count query', async () => {
    // JOBS_PAGE_SIZE + 1 rows fetched; the extra one is the signal, and it must
    // not leak into the rendered page.
    seed({ runs: 21 });
    const props = await renderSection(MEMBER);
    expect(props['hasNext']).toBe(true);
    expect(props['runs']).toHaveLength(20);
  });

  it('reports hasNext false at exactly one page', async () => {
    seed({ runs: 20 });
    const props = await renderSection(MEMBER);
    expect(props['hasNext']).toBe(false);
    expect(props['runs']).toHaveLength(20);
  });
});
