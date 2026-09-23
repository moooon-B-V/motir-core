// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { HistorySection } from '@/app/(authed)/items/[key]/_components/HistorySection';
import type { ActivityEntryDto, ActivityHistoryPageDto } from '@/lib/dto/activity';
import { renderToString } from 'react-dom/server';
import { bumpActivity, useActivityRevision } from '@/lib/hooks/useActivityRevision';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-6016 · MOTIR-6101 — a field saved on the item page shows in the
// History feed WITHOUT a reload. The feed is a client island seeded once from
// its server page, which `router.refresh()` cannot reach, so the save bumps the
// activity signal and the island re-reads its first page (the CLAUDE.md
// page-state contract's provider tick).

function entry(id: string, from: string, to: string): ActivityEntryDto {
  return {
    id,
    workItemId: 'wi-1',
    changeKind: 'updated',
    changedAt: '2026-09-23T08:00:00.000Z',
    actor: { userId: 'u-1', name: 'Mo', image: null },
    parts: [
      {
        kind: 'field',
        field: 'difficulty',
        from: { type: 'text', text: from },
        to: { type: 'text', text: to },
      },
    ] as ActivityEntryDto['parts'],
  };
}

const page = (entries: ActivityEntryDto[]): ActivityHistoryPageDto => ({
  entries,
  nextCursor: null,
  totalCount: entries.length,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the History feed after a save on the page', () => {
  it('re-reads its first page when the activity signal moves, and only then', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json(page([entry('r2', 'medium', 'high'), entry('r1', 'low', 'medium')])),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderWithIntl(
      <HistorySection
        workItemId="wi-1"
        initialPage={page([entry('r1', 'low', 'medium')])}
        headerControls={null}
        statusCategories={{}}
      />,
    );
    expect(screen.queryByText('high')).toBeNull();
    // Mounting reads nothing: the server page is the first window.
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => bumpActivity('wi-1'));

    await waitFor(() => expect(screen.getByText('high')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/work-items/wi-1/activity/history');
  });

  it('ignores a signal for a different work item', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderWithIntl(
      <HistorySection
        workItemId="wi-2"
        initialPage={page([])}
        headerControls={null}
        statusCategories={{}}
      />,
    );
    act(() => bumpActivity('wi-other'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useActivityRevision on the server', () => {
  it('renders 0 whatever the client store holds, so hydration cannot mismatch', () => {
    bumpActivity('wi-ssr');
    function Probe() {
      return <span>{useActivityRevision('wi-ssr')}</span>;
    }
    expect(renderToString(<Probe />)).toBe('<span>0</span>');
  });
});
