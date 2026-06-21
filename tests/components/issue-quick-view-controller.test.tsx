// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/lib/dto/quickView';

// The quick-view CONTROLLER (bug 8.8.2) — the reproduce-first guard for the two
// AC the bug fixes:
//   1. Opening renders the modal FRAME + skeleton INSTANTLY, before the item
//      data resolves (here: the fetch is still pending). "Open full page" is live
//      throughout the loading state.
//   2. The fields stream in via a CLIENT fetch of /api/work-items/peek; a 404 (stale
//      / deleted / cross-workspace / forbidden — the no-leak contract) lands on
//      the not-found panel, never a crash.
// The peek is URL-driven: the controller reads `?peek` from useSearchParams, so
// no peek → it renders nothing (the modal is dismissed the instant the param
// clears — the "instant close" half, with the shallow-routing close covered in
// issue-quick-view.test.tsx).
//
// The OPEN-LAG the bug fixed was structural: the peek used to be server-rendered
// behind each host page's blocking data reads, so the frame couldn't paint until
// that server work finished. This test pins the new behaviour — frame first,
// data after — at the unit level (an E2E timing assertion would be flaky).

let searchParamsString = 'peek=PROD-7';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

import { IssueQuickViewController } from '@/app/(authed)/items/_components/IssueQuickViewController';

const DATA: QuickViewData = {
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  kind: 'story',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'Sign in with email and password.',
  type: null,
  executor: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: 'Jun 12, 2026',
  sprintName: null,
  storyPoints: null,
  estimateLabel: '8h',
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: { identifier: 'PROD-1', title: 'Q3 launch', kind: 'epic' },
  readiness: null,
};

afterEach(() => {
  searchParamsString = 'peek=PROD-7';
  vi.unstubAllGlobals();
  cleanup();
});

describe('IssueQuickViewController — frame + skeleton render before the data', () => {
  it('opens the modal frame with the skeleton while the fetch is still pending', () => {
    // A fetch that never resolves — the modal must NOT wait on it to appear.
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchSpy);

    render(<IssueQuickViewController />);

    // The frame is up immediately…
    expect(screen.getByRole('dialog')).toBeTruthy();
    // …with the loading skeleton (its aria-live status region)…
    expect(screen.getByRole('status')).toBeTruthy();
    // …and "Open full page" live throughout the load (→ /items/PROD-7).
    expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe('/items/PROD-7');
    // …but the item's own fields have NOT resolved yet.
    expect(screen.queryByText(DATA.title)).toBeNull();
    // The fetch was fired client-side for the peeked key.
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/work-items/peek?key=PROD-7',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('swaps the skeleton for the populated panel when the fetch resolves', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(DATA), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<IssueQuickViewController />);

    await waitFor(() => expect(screen.getByText('Email + password sign-in')).toBeTruthy());
    expect(screen.getByText('Marco Ortiz')).toBeTruthy();
  });
});

describe('IssueQuickViewController — error + closed states', () => {
  it('renders the not-found panel on a 404 (no-existence-leak), never a crash', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    render(<IssueQuickViewController />);

    await waitFor(() => expect(screen.getByText('This work item isn’t available')).toBeTruthy());
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
  });

  it('renders nothing when there is no ?peek (the modal is dismissed instantly)', () => {
    searchParamsString = '';
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<IssueQuickViewController />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
