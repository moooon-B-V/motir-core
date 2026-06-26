// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import type { QuickViewData } from '@/lib/dto/quickView';

// The roadmap-canvas WORK-ITEM QUICK-VIEW (Subtask 7.20.11 / MOTIR-1352) — the
// LOCAL-state peek the canvas "View" button opens. It reuses the shipped /items
// peek surface verbatim (Modal + IssueQuickViewPanel + GET /api/work-items/peek);
// the only delta is the driver — `peekKey` in + `onClose` out, not the `?peek=`
// URL — so NO next/navigation mock is needed (the panel closes via `onClose`).
// This pins: frame+skeleton render before the data, the data streams in, a 404
// lands on not-found, null peekKey renders nothing, and close fires onClose.

const DATA: QuickViewData = {
  identifier: 'MOTIR-12',
  title: 'Build the planning canvas',
  projectIdentifier: 'MOTIR',
  workItemRefs: {},
  kind: 'subtask',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  descriptionMd: 'Render the project roadmap as a spatial canvas.',
  type: 'code',
  executor: 'coding_agent',
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'high',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: 3,
  estimateLabel: '40m',
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: { identifier: 'MOTIR-1', title: '7.20 Workspace', kind: 'story' },
  readiness: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('WorkItemQuickView', () => {
  it('opens the modal frame + skeleton immediately and fetches the peeked key', () => {
    // A fetch that never resolves — the frame must appear without waiting on it.
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchSpy);

    render(<WorkItemQuickView peekKey="MOTIR-12" onClose={() => {}} />);

    expect(screen.getByRole('dialog')).toBeTruthy(); // frame up immediately
    expect(screen.getByRole('status')).toBeTruthy(); // loading skeleton
    expect(screen.queryByText(DATA.title)).toBeNull(); // data not resolved yet
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/work-items/peek?key=MOTIR-12',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('streams the item fields in once the read resolves (reusing the shipped panel)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(DATA), { status: 200 })),
    );

    render(<WorkItemQuickView peekKey="MOTIR-12" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Build the planning canvas')).toBeTruthy());
    expect(screen.getByText('Marco Ortiz')).toBeTruthy();
    // The shipped peek's "Open full page →" links to the work item's detail page.
    expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe('/items/MOTIR-12');
  });

  it('renders the not-found panel on a 404 (no-existence-leak), never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 })),
    );

    render(<WorkItemQuickView peekKey="MOTIR-404" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('This work item isn’t available')).toBeTruthy());
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
  });

  it('renders nothing (no dialog, no fetch) when peekKey is null', () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<WorkItemQuickView peekKey={null} onClose={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('closes via the header × through the local onClose (not the URL)', async () => {
    const onClose = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(DATA), { status: 200 })),
    );

    render(<WorkItemQuickView peekKey="MOTIR-12" onClose={onClose} />);

    await waitFor(() => expect(screen.getByText('Build the planning canvas')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
