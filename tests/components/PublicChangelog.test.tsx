// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { PublicChangelogEntryDto } from '@/lib/dto/publicProjects';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicChangelog } from '@/app/(public)/_components/PublicChangelog';

// Story 8.9 · Subtask 8.9.4 — the public changelog list island (design
// `public-changelog.mock.html` Panel B).
//
// The island exists for ONE reason, the "Load more" pager, so that is what these
// assert: the day grouping the server ordering implies, the APPEND (not replace)
// on a page, the failure path that keeps what is already on screen, and the
// hydration-safe date rendering the mock's "2 hours ago" would have cost us.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function entry(over: Partial<PublicChangelogEntryDto> = {}): PublicChangelogEntryDto {
  return {
    identifier: 'PROD-1',
    key: 1,
    title: 'A shipped thing',
    kind: 'task',
    status: 'done',
    priority: 'medium',
    shippedAt: '2026-08-26T10:00:00.000Z',
    epic: null,
    ...over,
  };
}

describe('PublicChangelog — grouping and the entry row', () => {
  it('groups consecutive entries by UTC day, one heading per day', () => {
    renderWithIntl(
      <PublicChangelog
        identifier="PROD"
        initialCursor={null}
        initialEntries={[
          entry({ identifier: 'PROD-1', title: 'Shipped today A' }),
          entry({
            identifier: 'PROD-2',
            title: 'Shipped today B',
            shippedAt: '2026-08-26T09:00:00.000Z',
          }),
          entry({
            identifier: 'PROD-3',
            title: 'Shipped yesterday',
            shippedAt: '2026-08-25T23:59:59.000Z',
          }),
        ]}
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['26 August 2026', '25 August 2026']);
    expect(screen.getByText('Shipped today A')).toBeTruthy();
    expect(screen.getByText('Shipped yesterday')).toBeTruthy();
  });

  it('renders each day as a machine-readable <time>, not a relative string', () => {
    // The mock draws "2 hours ago" per entry; a relative timestamp computed on
    // the server and re-computed at hydration is the known mismatch trap, so the
    // day heading carries an absolute `dateTime` instead. A crawler wants this
    // too.
    const { container } = renderWithIntl(
      <PublicChangelog identifier="PROD" initialCursor={null} initialEntries={[entry()]} />,
    );
    const time = container.querySelector('time');
    expect(time?.getAttribute('dateTime')).toBe('2026-08-26');
    expect(screen.queryByText(/ago/i)).toBeNull();
  });

  it('links an entry to the PUBLIC item detail route, never the authed one', () => {
    renderWithIntl(
      <PublicChangelog
        identifier="PROD"
        initialCursor={null}
        initialEntries={[entry({ identifier: 'PROD-42' })]}
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/p/PROD/items/PROD-42');
  });

  it('shows the ancestor-epic chip only when there is one', () => {
    renderWithIntl(
      <PublicChangelog
        identifier="PROD"
        initialCursor={null}
        initialEntries={[
          entry({
            identifier: 'PROD-1',
            epic: { identifier: 'PROD-9', title: 'Launch readiness' },
          }),
          entry({ identifier: 'PROD-2', title: 'No epic', epic: null }),
        ]}
      />,
    );
    expect(screen.getByText('Launch readiness')).toBeTruthy();
    expect(screen.queryByText('PROD-9')).toBeNull();
  });
});

describe('PublicChangelog — the pager', () => {
  it('offers no Load more when the first page is the last', () => {
    renderWithIntl(
      <PublicChangelog identifier="PROD" initialCursor={null} initialEntries={[entry()]} />,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('APPENDS the next page rather than replacing it, and carries the new cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [entry({ identifier: 'PROD-2', title: 'From page two' })],
        nextCursor: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(
      <PublicChangelog
        identifier="PROD"
        initialCursor="CURSOR-1"
        initialEntries={[entry({ identifier: 'PROD-1', title: 'From page one' })]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByText('From page two')).toBeTruthy());
    // The first page is still on screen — a seek-after cursor cannot overlap, so
    // replacing would silently drop what the reader was looking at.
    expect(screen.getByText('From page one')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/public/p/PROD/changelog?cursor=CURSOR-1');
    // `nextCursor: null` ended the list, so the control goes away.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  });

  it('keeps the entries already on screen when a page FAILS, and offers the retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    renderWithIntl(
      <PublicChangelog
        identifier="PROD"
        initialCursor="CURSOR-1"
        initialEntries={[entry({ title: 'Still here' })]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Losing the page the reader already had would punish them for our error.
    expect(screen.getByText('Still here')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('does not fire a second request while one is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      release = r;
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await pending;
      return { ok: true, json: async () => ({ entries: [], nextCursor: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(
      <PublicChangelog identifier="PROD" initialCursor="C1" initialEntries={[entry()]} />,
    );

    const button = screen.getByRole('button', { name: 'Load more' });
    fireEvent.click(button);
    // The control is disabled while loading, so a second click cannot double-page
    // — which would skip a page, since the cursor has not advanced yet.
    expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      release(null);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('PublicChangelog — the zh catalog', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders the Chinese pager label from the real catalog', async () => {
    const zh = (await import('@/messages/zh.json')).default;
    renderWithIntl(
      <PublicChangelog identifier="PROD" initialCursor="C1" initialEntries={[entry()]} />,
      { locale: 'zh', messages: zh as Record<string, unknown> },
    );
    expect(screen.getByRole('button', { name: '加载更多' })).toBeTruthy();
  });
});
