// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { RequestedFeaturesList } from '@/app/(visitor)/p/[identifier]/requested-features/_components/RequestedFeaturesList';
import type {
  VisitorPendingRequestDto,
  VisitorPendingRequestPageDto,
} from '@/lib/dto/publicRequests';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The Visitor's Requested features list (Story MOTIR-6171 · MOTIR-6769; design
// MOTIR-6767 panels 1–3). The ONE write the Visitor view offers is the upvote on
// the existing public-request act route; "Load more" pages through the read's
// door. `fetch` is the boundary under test, so it is the one thing stubbed.

const row = (
  n: number,
  over: Partial<VisitorPendingRequestDto> = {},
): VisitorPendingRequestDto => ({
  id: `wi_${n}`,
  identifier: `ACME-${n}`,
  key: n,
  title: `Request ${n}`,
  kind: 'task',
  submitterName: `Person ${n}`,
  createdAt: '2026-09-20T10:00:00.000Z',
  voteCount: 3,
  voted: false,
  ...over,
});

const page = (
  items: VisitorPendingRequestDto[],
  over: Partial<VisitorPendingRequestPageDto> = {},
) => ({
  items,
  total: items.length,
  nextCursor: null,
  ...over,
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

const renderList = (initial: VisitorPendingRequestPageDto) =>
  renderWithIntl(<RequestedFeaturesList identifier="ACME" initial={initial} />, {
    now: new Date('2026-09-28T10:00:00.000Z'),
  });

const toggleOf = (identifier: string) =>
  within(screen.getByTestId(`requested-feature-${identifier}`)).getByRole('button');

describe('each row — the request, its submitter by name, and no Manager act', () => {
  it('renders the key, title, kind, name and age, and links into the Visitor item page', () => {
    renderList(page([row(1), row(2, { kind: 'bug', submitterName: 'Project member' })]));
    const first = screen.getByTestId('requested-feature-ACME-1');
    expect(first.textContent).toContain('ACME-1');
    expect(first.textContent).toContain('Request 1');
    expect(first.textContent).toContain('Feature request');
    expect(first.textContent).toContain('Person 1');
    expect(first.textContent).toContain('1 week ago');
    expect(within(first).getByRole('link').getAttribute('href')).toBe('/p/ACME/items/ACME-1');
    expect(screen.getByTestId('requested-feature-ACME-2').textContent).toContain('Bug report');
    // Name only, and not one control a Manager would use.
    expect(document.body.textContent).not.toContain('@');
    for (const act of [/accept/i, /decline/i, /promote/i, /snooze/i, /merge/i]) {
      expect(screen.queryByRole('button', { name: act })).toBeNull();
    }
    expect(document.body.textContent?.toLowerCase()).not.toContain('triage');
  });

  it('shows the empty state when nothing is pending', () => {
    renderList(page([]));
    expect(screen.getByTestId('requested-features-empty').textContent).toContain(
      'Nothing is waiting for a vote',
    );
  });
});

describe('the vote toggle', () => {
  it('upvotes, then removes the vote — the count is the SERVER’s answer each time', async () => {
    renderList(page([row(1, { voteCount: 3 })]));
    const toggle = toggleOf('ACME-1');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fetchMock.mockReturnValueOnce(json(200, { voted: true, voteCount: 7 }));
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/public-requests/wi_1/upvote', { method: 'POST' });
    expect(toggleOf('ACME-1').getAttribute('aria-pressed')).toBe('true');
    expect(toggleOf('ACME-1').textContent).toContain('7');

    fetchMock.mockReturnValueOnce(json(200, { voted: false, voteCount: 6 }));
    await act(async () => {
      fireEvent.click(toggleOf('ACME-1'));
    });
    expect(toggleOf('ACME-1').getAttribute('aria-pressed')).toBe('false');
    expect(toggleOf('ACME-1').textContent).toContain('6');
  });

  it('shows the new state while saving, and ignores a second press until it answers', async () => {
    renderList(page([row(1, { voteCount: 3 })]));
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    fireEvent.click(toggleOf('ACME-1'));
    expect(toggleOf('ACME-1').getAttribute('aria-pressed')).toBe('true');
    expect(toggleOf('ACME-1').getAttribute('aria-disabled')).toBe('true');
    expect(toggleOf('ACME-1').textContent).toContain('4');
    fireEvent.click(toggleOf('ACME-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({
        ok: true,
        status: 200,
        json: async () => ({ voted: true, voteCount: 4 }),
      } as Response);
    });
    expect(toggleOf('ACME-1').getAttribute('aria-disabled')).toBeNull();
  });

  it('a 429 restores the row and says so; an error says so differently', async () => {
    renderList(page([row(1, { voteCount: 3 }), row(2, { voteCount: 5, voted: true })]));

    fetchMock.mockReturnValueOnce(json(429, { code: 'RATE_LIMITED' }));
    await act(async () => {
      fireEvent.click(toggleOf('ACME-1'));
    });
    expect(toggleOf('ACME-1').getAttribute('aria-pressed')).toBe('false');
    expect(toggleOf('ACME-1').textContent).toContain('3');
    expect(screen.getByTestId('requested-feature-ACME-1').textContent).toContain(
      'You’re voting a little too fast',
    );

    fetchMock.mockReturnValueOnce(Promise.reject(new Error('offline')));
    await act(async () => {
      fireEvent.click(toggleOf('ACME-2'));
    });
    expect(toggleOf('ACME-2').getAttribute('aria-pressed')).toBe('true');
    expect(toggleOf('ACME-2').textContent).toContain('5');
    expect(screen.getByTestId('requested-feature-ACME-2').textContent).toContain(
      'Your vote wasn’t saved. Try again.',
    );

    // The next press clears the line.
    fetchMock.mockReturnValueOnce(json(500, {}));
    await act(async () => {
      fireEvent.click(toggleOf('ACME-1'));
    });
    expect(screen.getByTestId('requested-feature-ACME-1').textContent).toContain(
      'Your vote wasn’t saved. Try again.',
    );
  });
});

describe('Load more', () => {
  it('appends the next page in place, once, and hides the foot on the last page', async () => {
    renderList(page([row(1), row(2)], { total: 3, nextCursor: 'c1' }));
    expect(screen.getByText('Showing 2 of 3')).toBeTruthy();

    fetchMock.mockReturnValueOnce(json(200, page([row(2), row(3)], { total: 3 })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/p/ACME/requests?cursor=c1');
    // Row 2 moved between pages (a vote landed); it is not shown twice.
    expect(screen.getAllByTestId(/^requested-feature-/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed page keeps the loaded rows and offers Try again; a 429 says why', async () => {
    renderList(page([row(1)], { total: 2, nextCursor: 'c1' }));

    fetchMock.mockReturnValueOnce(json(500, {}));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    expect(screen.getByText('Couldn’t load more requests.')).toBeTruthy();
    expect(screen.getAllByTestId(/^requested-feature-/)).toHaveLength(1);

    fetchMock.mockReturnValueOnce(json(429, {}));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    });
    expect(screen.getByText(/You’re reading a little too fast/)).toBeTruthy();

    fetchMock.mockReturnValueOnce(Promise.reject(new Error('offline')));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    });
    expect(screen.getByText('Couldn’t load more requests.')).toBeTruthy();
  });
});
