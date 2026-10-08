// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '@/tests/helpers/renderWithIntl';
import zh from '@/messages/zh.json';
import type { WorkItemPageLinkRowDto, WorkItemPagesDto } from '@/lib/dto/pageLinks';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PagesSection } from '@/app/(authed)/items/[key]/_components/PagesSection';
import { fetchWorkItemPages, WorkItemPagesReadError } from '@/lib/workItems/pageLinksClient';

// MOTIR-7575 — the Pages section on the work item page, per
// design/work-items/item--pages-section.mock.html + design-notes § *The Pages
// section* (MOTIR-7569): every state (loading, populated, empty, error + retry,
// load more with its own loading and failed-next-page states), the three source
// labels, the place in the breadcrumb's vocabulary, and the relative time with
// the absolute one in its title.

const NOW = new Date('2026-10-07T12:00:00Z');

function row(over: Partial<WorkItemPageLinkRowDto> = {}): WorkItemPageLinkRowDto {
  return {
    pageId: 'pg_1',
    title: 'Onboarding flow — spec',
    sources: ['mention'],
    updatedAt: '2026-10-07T10:00:00Z',
    place: { folderPath: [], parentPageTitle: null },
    ...over,
  };
}

function page(rows: WorkItemPageLinkRowDto[], nextCursor: string | null = null): WorkItemPagesDto {
  return { rows, nextCursor };
}

function ok(body: WorkItemPagesDto): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch whose answers are released by hand, so pending states are observable. */
function heldFetch() {
  const calls: { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const fn = vi.fn(
    (url: string) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, resolve, reject });
      }),
  );
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

async function answer(
  call: { resolve: (r: Response) => void; reject: (e: unknown) => void } | undefined,
  response: Response | Error,
) {
  await act(async () => {
    if (response instanceof Error) call!.reject(response);
    else call!.resolve(response);
  });
}

function renderSection(messages?: Record<string, unknown>) {
  return renderWithIntl(<PagesSection workItemId="wi_1" identifier="PROD-7" />, {
    now: NOW,
    ...(messages ? { messages, locale: 'zh' } : {}),
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('the first read', () => {
  it('shows the two-bar pulse inside the section card while the read is in flight', async () => {
    const { fn, calls } = heldFetch();
    renderSection();
    expect(screen.getByRole('heading', { name: 'Pages' })).toBeTruthy();
    expect(screen.getByText('— where this item is written about')).toBeTruthy();
    expect(screen.getByTestId('pages-section-loading').getAttribute('aria-busy')).toBe('true');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe('/api/work-items/wi_1/pages');
    await answer(calls[0], ok(page([])));
    expect(screen.queryByTestId('pages-section-loading')).toBeNull();
  });

  it('carries the fragment id the design names, and renders no Link page door yet', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(calls[0], ok(page([])));
    expect(container.querySelector('#pages')).toBeTruthy();
    // MOTIR-7567 owns the door; nothing non-functional is drawn in its place.
    expect(screen.queryByRole('button', { name: /link page/i })).toBeNull();
  });

  it('lands on itself when the address carries #pages', async () => {
    window.location.hash = '#pages';
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const { calls } = heldFetch();
      const { container } = renderSection();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(container.querySelector('#pages'));
      await answer(calls[0], ok(page([])));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('says so when no page links here — and the section STAYS', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(calls[0], ok(page([])));
    expect(screen.getByText('No page links to this work item yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pages' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show more pages' })).toBeNull();
  });

  it('fails to a flush line with Try again, which refetches and replaces the line', async () => {
    const { fn, calls } = heldFetch();
    renderSection();
    await answer(calls[0], new Response('{}', { status: 500 }));
    const status = screen.getByRole('status');
    expect(within(status).getByText("Couldn't load pages.")).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();

    fireEvent.click(within(status).getByRole('button', { name: 'Try again' }));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1]!.url).toBe('/api/work-items/wi_1/pages');
    await answer(calls[1], ok(page([row()])));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('link', { name: /Onboarding flow — spec/ })).toBeTruthy();
  });

  it('a retry that fails again keeps the error line', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(calls[0], new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await answer(calls[1], new Response('{}', { status: 403 }));
    expect(screen.getByText("Couldn't load pages.")).toBeTruthy();
  });
});

describe('a populated row', () => {
  it('links the title to the page and lists the rows under the item’s accessible name', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(calls[0], ok(page([row(), row({ pageId: 'pg_2', title: 'Second page' })])));
    const list = screen.getByRole('list', { name: 'Pages that link to PROD-7' });
    const items = within(list)
      .getAllByRole('listitem', { name: undefined })
      .filter((li) => li.parentElement === list);
    expect(items).toHaveLength(2);
    expect(
      within(list)
        .getByRole('link', { name: /Onboarding flow — spec/ })
        .getAttribute('href'),
    ).toBe('/pages/pg_1');
    expect(
      within(list)
        .getByRole('link', { name: /Second page/ })
        .getAttribute('href'),
    ).toBe('/pages/pg_2');
  });

  it('labels every source of the closed union, in the fixed order Mentioned · Embedded · Linked', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(
      calls[0],
      ok(
        page([
          row({ pageId: 'a', title: 'Only mention', sources: ['mention'] }),
          row({ pageId: 'b', title: 'Only embed', sources: ['embed'] }),
          row({ pageId: 'c', title: 'Only manual', sources: ['manual'] }),
          row({ pageId: 'd', title: 'All three', sources: ['manual', 'embed', 'mention'] }),
        ]),
      ),
    );
    const labels = (title: string) =>
      Array.from(screen.getByRole('link', { name: new RegExp(title) }).querySelectorAll('span'))
        .map((s) => s.textContent)
        .filter((text): text is string => ['Mentioned', 'Embedded', 'Linked'].includes(text ?? ''));
    expect(labels('Only mention')).toEqual(['Mentioned']);
    expect(labels('Only embed')).toEqual(['Embedded']);
    expect(labels('Only manual')).toEqual(['Linked']);
    expect(labels('All three')).toEqual(['Mentioned', 'Embedded', 'Linked']);
  });

  it('reads an untitled page as Untitled', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(calls[0], ok(page([row({ title: '' })])));
    expect(screen.getByRole('link', { name: /Untitled/ }).getAttribute('href')).toBe('/pages/pg_1');
  });

  it('shows the last edit relative, with the absolute time in its title', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(calls[0], ok(page([row({ updatedAt: '2026-10-07T10:00:00Z' })])));
    const time = container.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe('2026-10-07T10:00:00Z');
    expect(time.textContent).toBe('2 hours ago');
    expect(time.getAttribute('title')).toMatch(/Oct 7, 2026/);
    expect(time.getAttribute('title')).toMatch(/10:00/);
  });
});

describe('the place — the page breadcrumb’s vocabulary, as a label', () => {
  const placeOf = (container: HTMLElement) =>
    container.querySelector<HTMLOListElement>('ol[aria-label="Where this page is"]')!;
  const segments = (ol: HTMLOListElement) =>
    Array.from(ol.children)
      .filter((li) => !li.hasAttribute('aria-hidden'))
      .map((li) => li.textContent);

  it('a page at the root reads just Pages', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(calls[0], ok(page([row()])));
    expect(segments(placeOf(container))).toEqual(['Pages']);
  });

  it('folders carry the Folder marker, and the place ends at the PARENT page', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(
      calls[0],
      ok(
        page([
          row({ place: { folderPath: ['Product', 'Auth'], parentPageTitle: 'Sign-in redesign' } }),
        ]),
      ),
    );
    const ol = placeOf(container);
    expect(segments(ol)).toEqual(['Pages', 'Folder:Product', 'Folder:Auth', 'Sign-in redesign']);
    expect(ol.getAttribute('title')).toBeNull();
    // Not links: the whole row is the page's link.
    expect(ol.querySelector('a')).toBeNull();
  });

  it('an untitled parent reads Untitled', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(calls[0], ok(page([row({ place: { folderPath: [], parentPageTitle: '' } })])));
    expect(segments(placeOf(container))).toEqual(['Pages', 'Untitled']);
  });

  it('folds a long trail into a plain … with the full path in its title', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(
      calls[0],
      ok(
        page([
          row({
            place: {
              folderPath: ['Planning', '2026', 'Q4', 'Reviews'],
              parentPageTitle: 'Roadmap',
            },
          }),
        ]),
      ),
    );
    const ol = placeOf(container);
    expect(segments(ol)).toEqual(['Pages', 'Folder:Planning', '…', 'Roadmap']);
    expect(ol.getAttribute('title')).toBe('Pages › Planning › 2026 › Q4 › Reviews › Roadmap');
  });
});

describe('Show more pages', () => {
  const first = Array.from({ length: 50 }, (_, i) => row({ pageId: `p${i}`, title: `Page ${i}` }));

  it('appends the next cursor’s rows with its own pending state, then disappears on the last page', async () => {
    const { fn, calls } = heldFetch();
    renderSection();
    await answer(calls[0], ok(page(first, 'cursor-1')));
    const list = screen.getByRole('list', { name: 'Pages that link to PROD-7' });
    expect(within(list).getAllByRole('link')).toHaveLength(50);

    const more = screen.getByRole('button', { name: 'Show more pages' });
    fireEvent.click(more);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1]!.url).toBe('/api/work-items/wi_1/pages?cursor=cursor-1');
    expect(screen.getByTestId('pages-section-loading-more').getAttribute('aria-busy')).toBe('true');
    expect((more as HTMLButtonElement).disabled).toBe(true);
    // A second press while one is in flight starts nothing.
    fireEvent.click(more);
    expect(fn).toHaveBeenCalledTimes(2);
    // The rows already shown stay while the next page loads.
    expect(within(list).getAllByRole('link')).toHaveLength(50);

    await answer(
      calls[1],
      ok(
        page(
          // `p49` overlaps the first page: it is shown once, never twice.
          [row({ pageId: 'p49', title: 'Page 49' }), row({ pageId: 'p50', title: 'Page 50' })],
          null,
        ),
      ),
    );
    expect(screen.queryByTestId('pages-section-loading-more')).toBeNull();
    expect(within(list).getAllByRole('link')).toHaveLength(51);
    expect(within(list).getAllByRole('link', { name: /Page 49/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Show more pages' })).toBeNull();
  });

  it('a failed next page keeps the rows and offers Try again, which reads the same cursor', async () => {
    const { calls } = heldFetch();
    renderSection();
    await answer(calls[0], ok(page(first, 'cursor-1')));
    fireEvent.click(screen.getByRole('button', { name: 'Show more pages' }));
    await answer(calls[1], new Response('{}', { status: 500 }));

    const status = screen.getByRole('status');
    expect(within(status).getByText("Couldn't load more pages.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more pages' })).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(50);

    fireEvent.click(within(status).getByRole('button', { name: 'Try again' }));
    expect(calls[2]!.url).toBe('/api/work-items/wi_1/pages?cursor=cursor-1');
    expect(screen.queryByRole('status')).toBeNull();
    await answer(calls[2], ok(page([row({ pageId: 'p50', title: 'Page 50' })], 'cursor-2')));
    expect(screen.getAllByRole('link')).toHaveLength(51);
    expect(screen.getByRole('button', { name: 'Show more pages' })).toBeTruthy();
  });
});

describe('a response that is no longer the latest never lands', () => {
  // The page keys the section on the item id, so in the app a new item is a new
  // section; re-rendering the same instance with a new id is how a test makes a
  // newer request start while an older one is still in flight.
  it('drops a first read — success or failure — answered after a newer read started', async () => {
    const { calls } = heldFetch();
    const { rerender } = renderSection();
    rerender(<PagesSection workItemId="wi_2" identifier="PROD-8" />);
    expect(calls[1]!.url).toBe('/api/work-items/wi_2/pages');
    await answer(calls[0], ok(page([row({ title: 'Stale' })])));
    expect(screen.queryByText('Stale')).toBeNull();
    rerender(<PagesSection workItemId="wi_3" identifier="PROD-9" />);
    await answer(calls[1], new Error('stale failure'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('pages-section-loading')).toBeTruthy();
    await answer(calls[2], new Error('offline'));
    expect(screen.getByText("Couldn't load pages.")).toBeTruthy();
  });

  it('drops a next page that succeeds after a newer read started', async () => {
    const { calls } = heldFetch();
    const { rerender } = renderSection();
    await answer(calls[0], ok(page([row()], 'cursor-1')));
    fireEvent.click(screen.getByRole('button', { name: 'Show more pages' }));
    rerender(<PagesSection workItemId="wi_2" identifier="PROD-8" />);
    await answer(calls[1], ok(page([row({ pageId: 'late', title: 'Late' })])));
    expect(screen.queryByText('Late')).toBeNull();
    // Still pending: the stale answer cleared nothing of the newer state.
    expect(screen.getByTestId('pages-section-loading-more')).toBeTruthy();
  });

  it('drops a next page that fails after a newer read started', async () => {
    const { calls } = heldFetch();
    const { rerender } = renderSection();
    await answer(calls[0], ok(page([row()], 'cursor-1')));
    fireEvent.click(screen.getByRole('button', { name: 'Show more pages' }));
    rerender(<PagesSection workItemId="wi_2" identifier="PROD-8" />);
    await answer(calls[1], new Error('offline'));
    expect(screen.queryByText("Couldn't load more pages.")).toBeNull();
    await answer(calls[2], ok(page([row({ pageId: 'n', title: 'New item page' })])));
    expect(screen.getByRole('link', { name: /New item page/ })).toBeTruthy();
  });
});

describe('the strings are catalogued in zh too', () => {
  it('renders the section in Chinese from messages/zh.json', async () => {
    const { calls } = heldFetch();
    renderSection(zh as unknown as Record<string, unknown>);
    await answer(calls[0], ok(page([row({ sources: ['mention', 'embed', 'manual'] })])));
    expect(screen.getByRole('heading', { name: '页面' })).toBeTruthy();
    expect(screen.getByText('已提及')).toBeTruthy();
    expect(screen.getByText('已嵌入')).toBeTruthy();
    expect(screen.getByText('已链接')).toBeTruthy();
  });
});

describe('fetchWorkItemPages', () => {
  it('encodes the id and the cursor, and throws a typed error on a non-2xx answer', async () => {
    const fn = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fn);
    await expect(fetchWorkItemPages('a/b', 'c d')).rejects.toBeInstanceOf(WorkItemPagesReadError);
    expect(fn).toHaveBeenCalledWith('/api/work-items/a%2Fb/pages?cursor=c+d');
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });
});

describe('withheld: the section is absent and its route is never read', () => {
  it('LateLowerSections renders no Pages section, so nothing fetches /pages', async () => {
    const fn = vi.fn(async () => ok(page([])));
    vi.stubGlobal('fetch', fn);
    const { LateLowerSections } =
      await import('@/app/(authed)/items/[key]/_components/LateSections');
    const reads = Promise.resolve({
      commentCaps: { canComment: false, canModerate: false },
      attachmentCaps: { canCreate: false, canDeleteAll: false },
      initialComments: null,
      initialHistory: null,
      initialAll: null,
      initialAttachments: null,
    });
    const props = {
      reads: reads as never,
      itemId: 'wi_1',
      itemIdentifier: 'PROD-7',
      currentUserId: 'u1',
      currentUserName: 'Yue',
      workflowStatuses: [] as never,
      mentionCandidates: [],
      activityTab: 'comments' as const,
    };
    type Tree = { props: { children: ({ type: unknown } | null)[] } };
    const withheld = (await LateLowerSections({ ...props, canViewPages: false })) as Tree;
    expect(withheld.props.children.some((c) => c?.type === PagesSection)).toBe(false);
    const holder = (await LateLowerSections({ ...props, canViewPages: true })) as Tree;
    expect(holder.props.children[0]?.type).toBe(PagesSection);

    // Building either tree reads nothing: the section's one read is its own, on mount.
    expect(fn).not.toHaveBeenCalled();
    // The cold dynamic import of the item page's lower sections (comments,
    // activity and attachments, with their editors) is ~14s on its own and
    // longer under the coverage lane's load, so the 15s default sat on the edge.
  }, 60_000);
});
