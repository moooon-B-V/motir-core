// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import type { EstimationConfigDto } from '@/lib/dto/estimation';

// EstimateBadge (Subtask 4.3.4) — the ONE inline estimate chip + picker reused
// across the backlog row / board card / issue-detail rail / list. The badge
// renders the project's configured statistic, opens a story-points picker
// (scale-deck chips + free numeric + clear), and writes through
// `PATCH /api/work-items/[id]/estimate` optimistically with snap-back on error.
// Rendered with the real `en` catalog + a controllable EstimationConfigProvider.

const { refreshSpy, toastSpy } = vi.hoisted(() => ({
  refreshSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

const STORY_POINTS_CONFIG: EstimationConfigDto = {
  estimationStatistic: 'story_points',
  pointScale: 'fibonacci',
  customScaleValues: [],
};

function renderBadge(
  ui: ReactElement,
  {
    config = STORY_POINTS_CONFIG,
    canEdit = true,
  }: { config?: EstimationConfigDto; canEdit?: boolean } = {},
) {
  return renderWithIntl(
    <EstimationConfigProvider config={config} canEdit={canEdit}>
      {ui}
    </EstimationConfigProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('EstimateBadge — display', () => {
  it('renders the story-point value when estimated', () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />);
    expect(screen.getByRole('button', { name: 'Story points: 5 — edit' })).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('renders the muted em-dash (never NaN) when unestimated', () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={null} />);
    const btn = screen.getByRole('button', { name: 'Add story points' });
    expect(btn.textContent).toContain('—');
  });

  it('degrades to a static read-only chip (no button) when the actor cannot edit', () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />, { canEdit: false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Estimate: 5')).toBeTruthy();
  });

  it('renders the configured TIME statistic, not raw story points', () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} estimateMinutes={90} />, {
      config: { ...STORY_POINTS_CONFIG, estimationStatistic: 'time_estimate' },
      canEdit: true,
    });
    // Time statistic → the formatted duration, and (story-points-only editing)
    // it degrades to a static chip.
    expect(screen.getByText('1h 30m')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing per-issue under the Issue count statistic', () => {
    const { container } = renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />, {
      config: { ...STORY_POINTS_CONFIG, estimationStatistic: 'issue_count' },
    });
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('always shows story points when forceStoryPoints is set, ignoring the statistic', () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={3} forceStoryPoints />, {
      config: { ...STORY_POINTS_CONFIG, estimationStatistic: 'time_estimate' },
    });
    expect(screen.getByRole('button', { name: 'Story points: 3 — edit' })).toBeTruthy();
  });
});

describe('EstimateBadge — picker', () => {
  it('opens the picker with the Fibonacci deck, a numeric input and clear', async () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));

    // Deck chips (Fibonacci default), each a real <button aria-pressed>.
    for (const v of [1, 2, 3, 5, 8, 13, 21]) {
      expect(await screen.findByRole('button', { name: `${v} story points` })).toBeTruthy();
    }
    // The active value is pressed.
    expect(
      screen.getByRole('button', { name: '5 story points' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // Free numeric input + clear.
    expect(screen.getByLabelText('Story points')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('reflects the configured custom scale deck', async () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={null} />, {
      config: {
        estimationStatistic: 'story_points',
        pointScale: 'custom',
        customScaleValues: [4, 2, 7],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add story points' }));
    // Sorted ascending + de-duplicated.
    expect(await screen.findByRole('button', { name: '2 story points' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '4 story points' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '7 story points' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '1 story points' })).toBeNull();
  });
});

describe('EstimateBadge — write', () => {
  it('PATCHes the picked value and refreshes on success', async () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));
    fireEvent.click(await screen.findByRole('button', { name: '8 story points' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/work-items/wi_1/estimate');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ points: 8 });
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('clears the estimate (points: null) via the Clear action', async () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({ points: null });
  });

  it('commits a free-numeric (decimal) entry on Enter', async () => {
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add story points' }));
    const input = await screen.findByLabelText('Story points');
    fireEvent.change(input, { target: { value: '0.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({ points: 0.5 });
  });

  it('snaps back and toasts an error when the write fails', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Nope' }) });
    renderBadge(<EstimateBadge itemId="wi_1" storyPoints={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story points: 5 — edit' }));
    fireEvent.click(await screen.findByRole('button', { name: '8 story points' }));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ variant: 'error', title: 'Nope' }));
    expect(refreshSpy).not.toHaveBeenCalled();
    // Snapped back to the server value.
    expect(screen.getByText('5')).toBeTruthy();
  });
});
