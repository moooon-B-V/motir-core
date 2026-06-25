// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { TierDocModal } from '@/components/planning/TierDocModal';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// Component tests for the on-canvas tier-doc viewer (Subtask 7.20.14 / MOTIR-1355):
// it fetches the active project's pre-plan state, finds the clicked tier's doc, and
// renders the shipped DirectionDocView inside the shared Modal — with loading,
// error, empty(no-doc) states and an "Open full page" link to /direction/[tier].

const DISCOVERY_BODY =
  '# Discovery (Tier 1)\n\nYou are building an internal tool for a small team.\n\n## Who it is for\n\n- The planner';

function stateWith(docs: PreplanStateDTO['docs']): PreplanStateDTO {
  return { session: null, docs, catalog: null };
}

function mockFetchResolving(state: PreplanStateDTO) {
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state) } as Response),
  ) as unknown as typeof fetch;
}

function mockFetchFailing() {
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as Response),
  ) as unknown as typeof fetch;
}

const discoveryDoc = {
  kind: 'discovery' as const,
  currentBody: DISCOVERY_BODY,
  currentVersion: 1,
  versions: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TierDocModal', () => {
  it('does not render the dialog when no tier is selected', () => {
    mockFetchResolving(stateWith([discoveryDoc]));
    render(<TierDocModal tier={null} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Closed → no fetch fired.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches the pre-plan and renders the tier doc (DirectionDocView) for the clicked tier', async () => {
    mockFetchResolving(stateWith([discoveryDoc]));
    render(<TierDocModal tier="discovery" onClose={() => {}} />);

    // The plain-language tier label (TIER_META.discovery.label) is the doc heading;
    // the jargon "# Discovery (Tier 1)" title is stripped by DirectionDocView.
    expect(await screen.findByText('Understanding your idea')).toBeTruthy();
    expect(screen.getByText(/building an internal tool for a small team/i)).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith('/api/ai/pre-plan', expect.anything());
  });

  it('renders an "Open full page" link to the tier doc route', async () => {
    mockFetchResolving(stateWith([discoveryDoc]));
    render(<TierDocModal tier="discovery" onClose={() => {}} />);

    const link = await screen.findByRole('link', { name: /open full page/i });
    expect(link.getAttribute('href')).toBe('/direction/discovery');
  });

  it('shows the empty state when the project has not drafted that tier', async () => {
    mockFetchResolving(stateWith([])); // no docs at all
    render(<TierDocModal tier="vision" onClose={() => {}} />);

    expect(await screen.findByText(/isn't ready yet/i)).toBeTruthy();
    // The doc body is never rendered in the empty state.
    expect(screen.queryByText(/building an internal tool/i)).toBeNull();
  });

  it('shows the error state when the pre-plan read fails', async () => {
    mockFetchFailing();
    render(<TierDocModal tier="discovery" onClose={() => {}} />);

    expect(await screen.findByText(/couldn't load this doc/i)).toBeTruthy();
  });

  it('closes via the Close button', async () => {
    mockFetchResolving(stateWith([discoveryDoc]));
    const onClose = vi.fn();
    render(<TierDocModal tier="discovery" onClose={onClose} />);

    await screen.findByText('Understanding your idea');
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
