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
    state: 'live',
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

function renderSection(messages?: Record<string, unknown>, canEditWorkItem = false) {
  return renderWithIntl(
    <PagesSection
      workItemId="wi_1"
      identifier="PROD-7"
      projectId="proj_1"
      canEditWorkItem={canEditWorkItem}
    />,
    {
      now: NOW,
      ...(messages ? { messages, locale: 'zh' } : {}),
    },
  );
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

  it('carries the fragment id the design names, and no Link page door for a reader who cannot edit', async () => {
    const { calls } = heldFetch();
    const { container } = renderSection();
    await answer(calls[0], ok(page([])));
    expect(container.querySelector('#pages')).toBeTruthy();
    // Absent, never disabled (MOTIR-9199).
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
    rerender(
      <PagesSection
        workItemId="wi_2"
        identifier="PROD-8"
        projectId="proj_1"
        canEditWorkItem={false}
      />,
    );
    expect(calls[1]!.url).toBe('/api/work-items/wi_2/pages');
    await answer(calls[0], ok(page([row({ title: 'Stale' })])));
    expect(screen.queryByText('Stale')).toBeNull();
    rerender(
      <PagesSection
        workItemId="wi_3"
        identifier="PROD-9"
        projectId="proj_1"
        canEditWorkItem={false}
      />,
    );
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
    rerender(
      <PagesSection
        workItemId="wi_2"
        identifier="PROD-8"
        projectId="proj_1"
        canEditWorkItem={false}
      />,
    );
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
    rerender(
      <PagesSection
        workItemId="wi_2"
        identifier="PROD-8"
        projectId="proj_1"
        canEditWorkItem={false}
      />,
    );
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
      projectId: 'proj_1',
    });
    const props = {
      reads: reads as never,
      itemId: 'wi_1',
      itemIdentifier: 'PROD-7',
      canEditWorkItem: false,
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
    // The late reads' project and the item's edit right reach the section (MOTIR-9199).
    expect(
      (holder.props.children[0] as unknown as { props: Record<string, unknown> }).props,
    ).toMatchObject({ projectId: 'proj_1', canEditWorkItem: false });

    // Building either tree reads nothing: the section's one read is its own, on mount.
    expect(fn).not.toHaveBeenCalled();
    // The cold dynamic import of the item page's lower sections (comments,
    // activity and attachments, with their editors) is ~14s on its own and
    // longer under the coverage lane's load, so the 15s default sat on the edge.
  }, 60_000);
});

// ── MOTIR-9199 — the Link page door, Unlink, the unavailable row ──────────────

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'pg_new',
  title: 'Meeting notes',
  place: { folderPath: ['Team'], parentPageTitle: null },
  ...over,
});

/** A fetch routed by method + URL; unmatched calls fail loudly. */
function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function openFormAndSearch(text = 'meet') {
  fireEvent.click(await screen.findByRole('button', { name: 'Link page' }));
  const input = screen.getByRole('combobox', { name: 'Search pages by title' });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe('the Link page door (MOTIR-9199)', () => {
  it('is drawn for a reader who may edit, and becomes Cancel while the form is open', async () => {
    routedFetch({ 'GET /api/work-items/wi_1/pages': () => json(page([])) });
    renderSection(undefined, true);
    const door = await screen.findByRole('button', { name: 'Link page' });
    fireEvent.click(door);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: 'Search pages by title' }),
    );
    expect(screen.getByText('Keep typing to search pages…')).toBeTruthy();
    // The empty line stays, with the door beside it.
    expect(screen.getByText('No page links to this work item yet.')).toBeTruthy();
  });

  it('links a picked page: pins it, keeps the rows, issues no re-read, and sends no page save', async () => {
    const fn = routedFetch({
      'GET /api/work-items/wi_1/pages': () =>
        json(
          page([row({ pageId: 'pg_new', title: 'Old' }), row({ pageId: 'p2', title: 'Other' })]),
        ),
      'GET /api/pages/link-search': () => json({ items: [candidate()], nextCursor: null }),
      'POST /api/work-items/wi_1/pages': () =>
        json({ pageId: 'pg_new', workItemId: 'wi_1', source: 'manual' }),
    });
    renderSection(undefined, true);
    await openFormAndSearch();
    const option = await screen.findByRole('option', { name: /Meeting notes/ });
    fireEvent.click(option);
    const pinned = await screen.findByTestId('pages-pinned');
    expect(within(pinned).getByText('Meeting notes')).toBeTruthy();
    expect(within(pinned).getByText('Just linked')).toBeTruthy();
    expect(within(pinned).getByText('Linked')).toBeTruthy();
    // The same page's paged row is suppressed; the other row stays.
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.getByText('Other')).toBeTruthy();
    expect(screen.queryByTestId('link-page-form')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Link page' })),
    );

    const calls = fn.mock.calls.map(
      ([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${String(u).split('?')[0]}`,
    );
    expect(calls.filter((c) => c === 'GET /api/work-items/wi_1/pages')).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('PATCH') || c.startsWith('PUT'))).toBe(false);
    const post = fn.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ pageId: 'pg_new' });
  });

  it.each([
    [409, 'PAGE_LINK_ALREADY_LINKED', '“Meeting notes” is already linked to this work item.'],
    [403, 'PERMISSION_DENIED', 'You don’t have permission to link pages to this work item.'],
    [404, 'PAGE_NOT_FOUND', 'That page is no longer available to link.'],
    [409, 'PAGE_ARCHIVED', 'That page is no longer available to link.'],
  ])(
    'maps a %i %s refusal to its own sentence with the query intact',
    async (status, code, sentence) => {
      routedFetch({
        'GET /api/work-items/wi_1/pages': () => json(page([])),
        'GET /api/pages/link-search': () => json({ items: [candidate()], nextCursor: null }),
        'POST /api/work-items/wi_1/pages': () => json({ code, error: 'x' }, status),
      });
      renderSection(undefined, true);
      const input = await openFormAndSearch();
      fireEvent.click(await screen.findByRole('option', { name: /Meeting notes/ }));
      expect(await screen.findByText(sentence)).toBeTruthy();
      expect((input as HTMLInputElement).value).toBe('meet');
      expect(screen.queryByTestId('pages-pinned')).toBeNull();
      // A new query clears the refusal.
      fireEvent.change(input, { target: { value: 'meeti' } });
      expect(screen.queryByText(sentence)).toBeNull();
    },
  );

  it('never reads an unrecognised 409 as already linked; it offers a retry that keeps the pick', async () => {
    let attempts = 0;
    routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([])),
      'GET /api/pages/link-search': () => json({ items: [candidate()], nextCursor: null }),
      'POST /api/work-items/wi_1/pages': () => {
        attempts += 1;
        return attempts === 1
          ? json({ code: 'SOMETHING_ELSE', error: 'x' }, 409)
          : json({ pageId: 'pg_new', workItemId: 'wi_1', source: 'manual' });
      },
    });
    renderSection(undefined, true);
    await openFormAndSearch();
    fireEvent.click(await screen.findByRole('option', { name: /Meeting notes/ }));
    expect(await screen.findByText('Couldn’t link that page.')).toBeTruthy();
    expect(screen.queryByText(/already linked/)).toBeNull();
    expect(screen.getByTestId('link-page-picked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('pages-pinned')).toBeTruthy();
  });

  it('closes on Escape and returns focus to the door', async () => {
    routedFetch({ 'GET /api/work-items/wi_1/pages': () => json(page([])) });
    renderSection(undefined, true);
    const input = await openFormAndSearch('');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('link-page-form')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Link page' })),
    );
  });
});

describe('Unlink (MOTIR-9199)', () => {
  const handRow = row({ pageId: 'pg_h', title: 'Hand page', sources: ['manual'] });
  const mixedRow = row({ pageId: 'pg_m', title: 'Mixed page', sources: ['manual', 'mention'] });
  const derivedRow = row({ pageId: 'pg_d', title: 'Derived page', sources: ['mention'] });

  it('is drawn on a hand link only, with the gloss line when a derived row is drawn; none for a reader who cannot edit', async () => {
    routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([handRow, mixedRow, derivedRow])),
    });
    renderSection(undefined, true);
    expect(await screen.findByRole('button', { name: 'Unlink page Hand page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlink page Mixed page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlink page Derived page' })).toBeNull();
    expect(screen.getByText(/Only hand links can be unlinked here/)).toBeTruthy();
    cleanup();

    routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([handRow, mixedRow, derivedRow])),
    });
    renderSection(undefined, false);
    await screen.findByText('Hand page');
    expect(screen.queryByRole('button', { name: /Unlink/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link page' })).toBeNull();
  });

  it('shows no gloss line while every drawn row is a hand link', async () => {
    routedFetch({ 'GET /api/work-items/wi_1/pages': () => json(page([handRow])) });
    renderSection(undefined, true);
    await screen.findByText('Hand page');
    expect(screen.queryByText(/Only hand links can be unlinked here/)).toBeNull();
  });

  it('removes a hand-only row, keeps a row another source still links, and never re-reads', async () => {
    const fn = routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([handRow, mixedRow])),
      'DELETE /api/work-items/wi_1/pages/pg_h': () => new Response(null, { status: 204 }),
      'DELETE /api/work-items/wi_1/pages/pg_m': () => new Response(null, { status: 204 }),
    });
    renderSection(undefined, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink page Hand page' }));
    await waitFor(() => expect(screen.queryByText('Hand page')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('Unlinked “Hand page”.');
    fireEvent.click(screen.getByRole('button', { name: 'Unlink page Mixed page' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Unlink page/ })).toBeNull());
    expect(screen.getByText('Mixed page')).toBeTruthy();
    expect(screen.getByText('Mentioned')).toBeTruthy();
    expect(screen.queryByText('Linked')).toBeNull();
    expect(fn.mock.calls.filter(([, i]) => !(i as RequestInit | undefined)?.method)).toHaveLength(
      1,
    );
  });

  it('restores the row and offers a retry when the unlink fails', async () => {
    let ok = false;
    routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([handRow])),
      'DELETE /api/work-items/wi_1/pages/pg_h': () =>
        ok ? new Response(null, { status: 204 }) : json({ code: 'BOOM' }, 500),
    });
    renderSection(undefined, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink page Hand page' }));
    expect(await screen.findByText('Couldn’t unlink that page.')).toBeTruthy();
    expect(screen.getByText('Hand page')).toBeTruthy();
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Hand page')).toBeNull());
  });

  it('settles a page-gone answer as removed', async () => {
    routedFetch({
      'GET /api/work-items/wi_1/pages': () => json(page([handRow])),
      'DELETE /api/work-items/wi_1/pages/pg_h': () => json({ code: 'PAGE_LINK_NOT_FOUND' }, 404),
    });
    renderSection(undefined, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink page Hand page' }));
    await waitFor(() => expect(screen.queryByText('Hand page')).toBeNull());
    expect(screen.queryByText('Couldn’t unlink that page.')).toBeNull();
  });
});

describe('the row arms (MOTIR-9199)', () => {
  it('draws a live row as before: an anchor and a relative time', async () => {
    routedFetch({ 'GET /api/work-items/wi_1/pages': () => json(page([row()])) });
    renderSection();
    expect(await screen.findByRole('link', { name: /Onboarding flow/ })).toBeTruthy();
    expect(document.querySelector('time')).toBeTruthy();
  });

  it.each(['unavailable', 'archived-but-new-value'])(
    'draws state %s as the unavailable arm: no anchor, no time, chips and place kept, Unlink offered',
    async (state) => {
      routedFetch({
        'GET /api/work-items/wi_1/pages': () =>
          json(
            page([
              row({
                pageId: 'pg_u',
                title: 'Gone page',
                state: state as never,
                sources: ['manual', 'mention'],
                place: { folderPath: ['Team'], parentPageTitle: 'Handbook' },
              }),
            ]),
          ),
      });
      renderSection(undefined, true);
      expect(await screen.findByText('Gone page')).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
      expect(document.querySelector('time')).toBeNull();
      expect(screen.getByText('Unavailable page')).toBeTruthy();
      expect(screen.getByText('Linked')).toBeTruthy();
      expect(screen.getByText('Mentioned')).toBeTruthy();
      expect(screen.getByText('Handbook')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Unlink page Gone page' })).toBeTruthy();
    },
  );

  it('names Unlink distinctly on a row that carries no title', async () => {
    routedFetch({
      'GET /api/work-items/wi_1/pages': () =>
        json(page([row({ pageId: 'pg_u', title: '', state: 'unavailable', sources: ['manual'] })])),
    });
    renderSection(undefined, true);
    expect(await screen.findByRole('button', { name: 'Unlink unavailable page' })).toBeTruthy();
  });

  it('does not draw the empty line for a work item whose only link is unavailable', async () => {
    routedFetch({
      'GET /api/work-items/wi_1/pages': () =>
        json(page([row({ state: 'unavailable', sources: ['mention'] })])),
    });
    renderSection();
    await screen.findByText('Unavailable page');
    expect(screen.queryByText('No page links to this work item yet.')).toBeNull();
  });
});
