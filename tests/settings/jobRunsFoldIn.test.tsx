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

// ⚠️ THE PANE IS MOCKED, NOT THE DASHBOARD — and the move is the point.
//
// MOTIR-4849 extracted `JobsPane`: the param parsing and the three reads, in ONE
// place, because this surface has TWO doors and a second copy of "which tab did
// they ask for, and may they have it" is a second answer waiting to disagree.
// So the reads this file used to assert HERE now belong to the pane, are
// asserted in `tests/settings/jobsPane.test.tsx`, and are thereby covered for
// BOTH doors rather than only this one.
//
// What is left for this file is what the fold-in still decides for itself, and
// it is exactly the part that was wrong: WHERE the dashboard's links point, and
// WHICH view the host page's query selects.
const paneProps = vi.fn();
vi.mock('@/app/(authed)/settings/workspace/jobs/_components/JobsPane', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/app/(authed)/settings/workspace/jobs/_components/JobsPane')
  >()),
  JobsPane: (props: Record<string, unknown>) => {
    paneProps(props);
    return <div data-testid="jobs-pane" />;
  },
}));

import { JobRunsFoldInSection } from '@/app/(authed)/settings/organization/_components/JobRunsFoldInSection';

const WORKSPACE_ID = 'ws1';
// `searchParams` is REQUIRED now (MOTIR-4849): the section is URL-driven,
// because a dashboard whose tabs and filters are links needs them to point at
// the page that renders it. `{}` is the default view every case below wants.
const MEMBER = {
  workspaceId: WORKSPACE_ID,
  actorUserId: 'u1',
  actorEmail: 'member@example.com',
  searchParams: {},
};

async function renderSection(props: Parameters<typeof JobRunsFoldInSection>[0]) {
  render(await JobRunsFoldInSection(props));
  return paneProps.mock.calls.at(-1)![0] as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete process.env['PLATFORM_ADMIN_EMAIL'];
});

describe('the Job runs fold-in — it renders for a WORKSPACE MEMBER', () => {
  it('renders for a plain member, with no org role anywhere in its signature', async () => {
    await renderSection(MEMBER);
    expect(screen.getByTestId('jobs-pane')).toBeTruthy();
    // The structural half of §6d here: the section takes a workspace id, a user
    // id and an email. There is no org role in its inputs at all, so it CANNOT
    // inherit the host page's admin gate even by accident.
    const props = paneProps.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(props['workspaceId']).toBe(WORKSPACE_ID);
    expect(props['userId']).toBe('u1');
  });

  it('⚠️ the WORKSPACE-scoped reads moved to the pane, and are asserted there', async () => {
    // Kept as a signpost rather than deleted (MOTIR-4849). This file used to
    // assert `listJobRuns`/`countDLQ` were called with the workspace and the
    // actor — the claim that the fold-in reads the WORKSPACE's runs and not an
    // org-scoped list. That read is `JobsPane`'s now and is asserted in
    // `tests/settings/jobsPane.test.tsx`, where it covers BOTH doors instead of
    // this one. A reader who comes here looking for it should be told where it
    // went, not find it missing.
    const props = await renderSection(MEMBER);
    expect(props['workspaceId']).toBe(WORKSPACE_ID);
  });
});

describe('the Job runs fold-in — the SYSTEM tab gate, which it still owns', () => {
  it('is present only when the request email matches PLATFORM_ADMIN_EMAIL', async () => {
    process.env['PLATFORM_ADMIN_EMAIL'] = 'staff@motir.co';
    const staff = await renderSection({ ...MEMBER, actorEmail: 'staff@motir.co' });
    expect(staff['showSystemTab']).toBe(true);
  });

  it('is ABSENT for everyone else, and when the env var is unset', async () => {
    process.env['PLATFORM_ADMIN_EMAIL'] = 'staff@motir.co';
    expect((await renderSection(MEMBER))['showSystemTab']).toBe(false);
    cleanup();
    delete process.env['PLATFORM_ADMIN_EMAIL'];
    // ⚠️ With no admin email configured NOBODY sees it — not everybody. An
    // `email === undefined` comparison would open it to any user whose email is
    // missing, which is why the source guards on `Boolean(adminEmail)` first.
    expect((await renderSection({ ...MEMBER, actorEmail: '' }))['showSystemTab']).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MOTIR-4849 — THE LINKS, which the cases above are structurally blind to
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠️ EVERY CASE ABOVE PASSED WHILE THIS SECTION WAS UNUSABLE, and that is worth
// stating plainly rather than quietly fixing. They mock `JobsDashboard` and
// assert the PROPS handed to it — the right instrument for "did the gates travel
// with the surface", and structurally incapable of seeing whether the thing they
// handed those props to works.
//
// It did not. `JobsDashboard` built every tab, status filter and pagination link
// from a module-level `BASE = '/settings/workspace/jobs'`, and this story made
// that route `notFound()` at exactly the workspace count where this fold-in is
// the ONLY door. The section drew, the DLQ badge showed a count, and nothing in
// it could be opened — including the dead-letter queue, which is the one thing a
// tenant comes here to do.
//
// So this block asserts the ADDRESS the section hands down. The rendered-href
// half lives in `tests/settings/jobsDashboardBasePath.test.tsx`, which mounts
// the real component; between them the claim is closed at both ends.
describe('the fold-in points its own links HOME', () => {
  it('hands the dashboard THIS page as its link base, never the workspace route', async () => {
    const props = await renderSection(MEMBER);
    expect(props['basePath']).toBe('/settings/organization');
    // The route this fold-in exists BECAUSE it 404s. A link base naming it is
    // the defect, so it is asserted absent rather than merely not-expected.
    expect(props['basePath']).not.toBe('/settings/workspace/jobs');
  });

  it("is URL-DRIVEN — the host page's query selects the tab, status and page", async () => {
    // Pinned `activeTab="runs"` / `page={1}` was the other half of the bug: even
    // with a correct base, a section that ignores its own query cannot be
    // navigated, so the tab links would change the URL and nothing on screen.
    const props = await renderSection({
      ...MEMBER,
      searchParams: { tab: 'dlq', status: 'failed', page: '3' },
    });
    // The pane's prop is `tab` — `activeTab` is what it hands the DASHBOARD,
    // one layer further down. Asserting the wrong name here read as "the query
    // is ignored", which is the very defect this case exists to catch.
    expect(props['tab']).toBe('dlq');
    expect(props['status']).toBe('failed');
    expect(props['page']).toBe(3);
  });

  it('falls back to `runs` for a non-admin arriving on `?tab=system`', async () => {
    // The same coercion the standalone route applies, through the same parser —
    // a shared URL must not refuse a reader, on either door.
    const props = await renderSection({ ...MEMBER, searchParams: { tab: 'system' } });
    expect(props['tab']).toBe('runs');
    expect(props['showSystemTab']).toBe(false);
  });
});
