// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4843 · MOTIR-4849 — WHERE THE JOBS DASHBOARD'S OWN LINKS POINT.
//
// ⚠️ THIS FILE EXISTS BECAUSE A GREEN SUITE SHIPPED AN UNUSABLE SURFACE. The
// dashboard has TWO hosts: its own route above the workspace-tier reveal, and
// `JobRunsFoldInSection` on `/settings/organization` below it — where it is the
// ONLY door, because the same story made the workspace route `notFound()` at
// that count.
//
// It built every tab, status filter and pagination link from a module-level
// `BASE = '/settings/workspace/jobs'`. Mounted in the fold-in, all of them
// pointed at the 404. The section rendered, the DLQ badge showed a count, and
// the dead-letter queue — a bounced invite, and an owner who can replay it, the
// one thing a tenant actually comes here for — could not be opened.
//
// `tests/settings/jobRunsFoldIn.test.tsx` could not see it: it MOCKS this
// component and asserts the props handed to it. That is the correct instrument
// for "did the gates travel with the surface" and it is structurally blind to
// "does the thing you handed them work". So this file mounts the REAL component
// and reads the hrefs off the DOM — the assertion that closes the other end.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/organization',
}));
vi.mock('@/app/(authed)/settings/workspace/jobs/actions', () => ({
  replayDlqAction: vi.fn(),
}));

import { JobsDashboard } from '@/app/(authed)/settings/workspace/jobs/_components/JobsDashboard';

const WORKSPACE_ROUTE = '/settings/workspace/jobs';
const ORG_ROUTE = '/settings/organization';

function render(basePath?: string) {
  return renderWithIntl(
    <JobsDashboard
      {...(basePath === undefined ? {} : { basePath })}
      activeTab="runs"
      page={1}
      hasNext
      dlqCount={2}
      isOwner
      showSystemTab={false}
      runs={[]}
      dlq={[]}
    />,
  );
}

/** Every in-dashboard link, as hrefs. */
function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!);
}

afterEach(cleanup);

describe('the dashboard addresses the host that renders it', () => {
  it('⚠️ mounted at the ORG page, NO link names the workspace route', () => {
    // The whole bug, stated as one assertion. Not "the tabs work" — no link at
    // all may name a route that 404s for the reader who is seeing this mount.
    const { container } = render(ORG_ROUTE);
    const all = hrefs(container);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((h) => h.startsWith(WORKSPACE_ROUTE))).toEqual([]);
    for (const href of all) {
      expect(href.startsWith(ORG_ROUTE), href).toBe(true);
    }
  });

  it('the DEAD-LETTER tab is reachable from the org page — the capability §6d protects', () => {
    // Named on its own rather than left to the sweep above, because this is the
    // link whose breakage actually cost something: a teammate's invite bounced,
    // and the owner who can replay it could not reach the queue.
    render(ORG_ROUTE);
    const dlq = screen.getByRole('link', { name: /Dead letter/ });
    expect(dlq.getAttribute('href')).toBe(`${ORG_ROUTE}?tab=dlq`);
  });

  it('the status filters and the pager come home too, not just the tabs', () => {
    // Three link families are built from the base; fixing one is the shape of
    // this bug recurring. The pager only renders with a page to go to, which is
    // what `hasNext` is for above.
    const { container } = render(ORG_ROUTE);
    const all = hrefs(container);
    expect(all).toContain(`${ORG_ROUTE}?status=failed`);
    expect(all).toContain(`${ORG_ROUTE}?page=2`);
  });

  it('DEFAULTS to the workspace route — the standalone host passes nothing', () => {
    // The default is what keeps the original route's call sites honest, so it is
    // asserted rather than assumed: a default that drifted would silently
    // re-point the surface that has been shipping since 1.6.5.
    const { container } = render(undefined);
    expect(hrefs(container).every((h) => h.startsWith(WORKSPACE_ROUTE))).toBe(true);
  });

  it('carries the tab, the status and the page together, on either host', () => {
    // The query is built from the same three inputs on both doors, so a deep
    // link shared from one is a deep link on the other.
    for (const base of [ORG_ROUTE, WORKSPACE_ROUTE]) {
      cleanup();
      const { container } = renderWithIntl(
        <JobsDashboard
          basePath={base}
          activeTab="runs"
          status="failed"
          page={2}
          hasNext={false}
          dlqCount={0}
          isOwner={false}
          showSystemTab={false}
          runs={[]}
          dlq={[]}
        />,
      );
      expect(hrefs(container), base).toContain(`${base}?tab=dlq&status=failed`);
    }
  });
});
