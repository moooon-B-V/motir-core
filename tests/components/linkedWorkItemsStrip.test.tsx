// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '@/tests/helpers/renderWithIntl';
import zh from '@/messages/zh.json';
import type { PageWorkItemLinkRowDto, PageWorkItemsDto } from '@/lib/dto/pageLinks';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/pages/pg_1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LinkedWorkItemsStrip } from '@/app/(authed)/pages/[pageId]/_components/LinkedWorkItemsStrip';

// MOTIR-9200 — the page's Linked work items strip, per
// design/pages/page--linked-work-items.mock.html (panels 1–12): the four row
// renderings, the visibility matrix, the picker, the pick-is-the-write flow with its
// refusals and rollbacks, unlink, paging and the no-save guarantee.

const live = (
  id: string,
  key: string,
  title: string,
  archived = false,
): PageWorkItemLinkRowDto => ({
  workItemId: id,
  linkedAt: '2026-10-07T10:00:00Z',
  summary: {
    accessible: true,
    id,
    identifier: key,
    title,
    kind: 'task',
    archived,
    status: { key: 'todo', category: 'todo', label: 'To do' } as never,
    type: null,
    assignee: null,
  },
});
const hidden = (id: string): PageWorkItemLinkRowDto => ({
  workItemId: id,
  linkedAt: '2026-10-07T10:00:00Z',
  summary: { accessible: false, id },
});
const gone = (id: string): PageWorkItemLinkRowDto => ({
  workItemId: id,
  linkedAt: '2026-10-07T10:00:00Z',
  summary: null,
});

const dto = (
  rows: PageWorkItemLinkRowDto[],
  nextCursor: string | null = null,
): PageWorkItemsDto => ({
  rows,
  nextCursor,
  canLink: true,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

const READ = 'GET /api/pages/pg_1/work-items';

function mount(
  canLink: boolean,
  opts: { projectId?: string | null; messages?: Record<string, unknown> } = {},
) {
  return renderWithIntl(
    <LinkedWorkItemsStrip
      pageId="pg_1"
      projectId={opts.projectId === null ? undefined : (opts.projectId ?? 'proj_1')}
      canLink={canLink}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the rows', () => {
  it('draws a live chip as a peek link, an archived one still navigable, and one Unavailable row for both unresolvable arms', async () => {
    routedFetch({
      [READ]: () =>
        json(
          dto([
            live('a', 'PROD-1', 'Live one'),
            live('b', 'PROD-2', 'Old one', true),
            hidden('c'),
            gone('d'),
          ]),
        ),
    });
    mount(true);
    const list = await screen.findByRole('list', { name: 'Work items linked by hand' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(
      within(items[0]!)
        .getByRole('link', { name: /PROD-1/ })
        .getAttribute('href'),
    ).toBe('/items/PROD-1');
    expect(items[1]!.querySelector('.is-archived')).toBeTruthy();
    expect(within(items[1]!).getByRole('link', { name: /PROD-2/ })).toBeTruthy();
    for (const i of [2, 3]) {
      expect(within(items[i]!).queryByRole('link')).toBeNull();
      expect(items[i]!.querySelector('.is-noaccess')?.textContent).toBe('Unavailable');
      expect(items[i]!.querySelector('.wi-chip')?.getAttribute('title')).toBe(
        'This work item isn’t available to you.',
      );
    }
    // Unlink survives on an unavailable row.
    expect(within(items[2]!).getByRole('button', { name: 'Unlink Unavailable' })).toBeTruthy();
    expect(within(items[0]!).getByRole('button', { name: 'Unlink PROD-1' })).toBeTruthy();
  });
});

describe('visibility', () => {
  it('reader who can link: frame and skeleton while loading, empty line plus the control when empty', async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    mount(true);
    expect(screen.getByText('Linked work items')).toBeTruthy();
    expect(screen.getByTestId('linked-strip-loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Link work item' })).toBeNull();
    await act(async () => release(json(dto([]))));
    expect(screen.getByText('No work items linked by hand yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Link work item' })).toBeTruthy();
  });

  it('reader who cannot link: nothing while loading and nothing when empty', async () => {
    routedFetch({ [READ]: () => json(dto([])) });
    const { container } = mount(false);
    expect(container.textContent).toBe('');
    await act(async () => {});
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('reader who cannot link, with rows: rows drawn, no control and no Unlink anywhere', async () => {
    routedFetch({ [READ]: () => json(dto([live('a', 'PROD-1', 'Live one')])) });
    mount(false);
    await screen.findByText('Live one');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws no linking control when the page carries no project', async () => {
    routedFetch({ [READ]: () => json(dto([live('a', 'PROD-1', 'Live one')])) });
    mount(true, { projectId: null });
    await screen.findByText('Live one');
    expect(screen.queryByRole('button', { name: 'Link work item' })).toBeNull();
  });
});

describe('the first read and paging', () => {
  it('keeps the frame on a failed first read and retries the FIRST page', async () => {
    let n = 0;
    const fn = routedFetch({
      [READ]: () => (++n === 1 ? json({}, 500) : json(dto([live('a', 'PROD-1', 'Live one')]))),
    });
    mount(true);
    expect(await screen.findByText('Couldn’t load linked work items.')).toBeTruthy();
    expect(screen.queryByText('No work items linked by hand yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link work item' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Live one');
    expect(fn.mock.calls.every(([u]) => !String(u).includes('cursor'))).toBe(true);
  });

  it('appends the next page without duplicates and retries exactly the cursor that failed', async () => {
    let more = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (!url.includes('cursor=')) return json(dto([live('a', 'PROD-1', 'One')], 'c1'));
        return ++more === 1
          ? json({}, 500)
          : json(dto([live('a', 'PROD-1', 'One'), live('b', 'PROD-2', 'Two')]));
      }),
    );
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(
      await screen.findByText('Couldn’t load the rest of the linked work items.'),
    ).toBeTruthy();
    expect(screen.getByText('One')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Two');
    expect(screen.getAllByText('One')).toHaveLength(1);
    expect(urls.filter((u) => u.includes('cursor=c1'))).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('the picker and the write', () => {
  const cand = (id: string, key: string, title: string) => ({
    id,
    identifier: key,
    title,
    kind: 'task',
    status: null,
  });
  const SEARCH = 'GET /api/work-items/mention-search';

  async function openPicker(text = 'pay') {
    fireEvent.click(await screen.findByRole('button', { name: 'Link work item' }));
    const input = await screen.findByRole('combobox', { name: 'Work items in this project' });
    return { input, type: () => fireEvent.change(input, { target: { value: text } }) };
  }

  it('shows the type-to-search hint under two characters and issues no search', async () => {
    const fn = routedFetch({ [READ]: () => json(dto([])) });
    mount(true);
    const { input } = await openPicker();
    expect(screen.getByText('Type at least 2 characters to search.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'p' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(fn.mock.calls.some(([u]) => String(u).includes('mention-search'))).toBe(false);
  });

  it('searches the page’s project, shows the full-window line at eight, and a failure with a retry', async () => {
    let fail = true;
    const eight = Array.from({ length: 8 }, (_, i) => cand(`w${i}`, `PROD-${i}`, `Item ${i}`));
    const fn = routedFetch({
      [READ]: () => json(dto([])),
      [SEARCH]: () => (fail ? json({}, 500) : json(eight.map((c) => ({ ...c, status: 'todo' })))),
    });
    mount(true);
    const { type } = await openPicker();
    type();
    expect(await screen.findByText('Couldn’t search work items.')).toBeTruthy();
    expect(screen.queryByText('No work items match.')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('option', { name: /Item 0/ });
    expect(screen.getByText('More work items match — keep typing to narrow.')).toBeTruthy();
    const url = String(fn.mock.calls.find(([u]) => String(u).includes('mention-search'))![0]);
    expect(url).toContain('projectId=proj_1');
  });

  it('says so when nothing matches', async () => {
    routedFetch({ [READ]: () => json(dto([])), [SEARCH]: () => json([]) });
    mount(true);
    const { type } = await openPicker();
    type();
    expect(await screen.findByText('No work items match.')).toBeTruthy();
  });

  it('a pick posts the pair, draws a pending row, then re-reads the first page — with no page save', async () => {
    let reads = 0;
    let release!: (r: Response) => void;
    const fn = routedFetch({
      [READ]: () =>
        ++reads === 1
          ? json(dto([]))
          : json(dto([live('w1', 'PROD-1', 'Pay invoices'), live('w9', 'PROD-9', 'Older')])),
      [SEARCH]: () => json([{ ...cand('w1', 'PROD-1', 'Pay invoices'), status: 'todo' }]),
      'POST /api/work-items/w1/pages': () => new Promise<Response>((r) => (release = r)),
    });
    mount(true);
    const { type } = await openPicker();
    type();
    fireEvent.click(await screen.findByRole('option', { name: /Pay invoices/ }));
    const pendingRow = await screen.findByTestId('linked-pending-row');
    expect(pendingRow.getAttribute('aria-busy')).toBe('true');
    expect(pendingRow.querySelector('.wi-dot')).toBeNull();
    const post = fn.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ pageId: 'pg_1' });
    await act(async () => release(json({ pageId: 'pg_1', workItemId: 'w1', source: 'manual' })));
    await screen.findByRole('link', { name: /PROD-1/ });
    expect(screen.queryByTestId('linked-pending-row')).toBeNull();
    expect(screen.getAllByText('Pay invoices')).toHaveLength(1);
    expect(
      fn.mock.calls.some(([u, i]) => {
        const m = (i as RequestInit | undefined)?.method;
        return m === 'PATCH' || m === 'PUT' || String(u).includes('/updates');
      }),
    ).toBe(false);
  });

  it('shows the write-failed line when the request itself fails, and withdraws the pending row', async () => {
    routedFetch({
      [READ]: () => json(dto([])),
      [SEARCH]: () => json([{ ...cand('w1', 'PROD-1', 'Pay invoices'), status: 'todo' }]),
      'POST /api/work-items/w1/pages': () => {
        throw new TypeError('offline');
      },
    });
    mount(true);
    const { type } = await openPicker();
    type();
    fireEvent.click(await screen.findByRole('option', { name: /Pay invoices/ }));
    expect(await screen.findByText('Couldn’t link that work item. Try again.')).toBeTruthy();
    expect(screen.queryByTestId('linked-pending-row')).toBeNull();
  });

  it('wraps ArrowUp, follows the pointer, and draws one pending row for a pair picked twice', async () => {
    routedFetch({
      [READ]: () => json(dto([])),
      [SEARCH]: () =>
        json([
          { ...cand('w1', 'PROD-1', 'First'), status: 'todo' },
          { ...cand('w2', 'PROD-2', 'Second'), status: 'todo' },
        ]),
      'POST /api/work-items/w1/pages': () => new Promise<Response>(() => {}),
    });
    mount(true);
    const first = await openPicker();
    first.type();
    await screen.findByRole('option', { name: /Second/ });
    fireEvent.keyDown(first.input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /Second/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.mouseEnter(screen.getByRole('option', { name: /First/ }));
    fireEvent.click(screen.getByRole('option', { name: /First/ }));
    await screen.findByTestId('linked-pending-row');

    const again = await openPicker();
    again.type();
    fireEvent.click(await screen.findByRole('option', { name: /First/ }));
    await waitFor(() => expect(screen.getAllByTestId('linked-pending-row')).toHaveLength(1));
  });

  it.each([
    [409, 'PAGE_LINK_ALREADY_LINKED', 'That work item is already linked to this page.'],
    [403, 'WORK_ITEM_EDIT_DENIED', 'You can’t change this page’s links.'],
    [404, 'WORK_ITEM_NOT_FOUND', 'That work item no longer exists.'],
    [500, 'X', 'Couldn’t link that work item. Try again.'],
  ])(
    'a %i %s refusal withdraws the pending row, adds no row and shows its own line',
    async (status, code, line) => {
      routedFetch({
        [READ]: () => json(dto([live('a', 'PROD-1', 'Existing')])),
        [SEARCH]: () => json([{ ...cand('w1', 'PROD-1', 'Pay invoices'), status: 'todo' }]),
        'POST /api/work-items/w1/pages': () => json({ code, error: 'x' }, status),
      });
      mount(true);
      const { type } = await openPicker();
      type();
      fireEvent.click(await screen.findByRole('option', { name: /Pay invoices/ }));
      expect(await screen.findByText(line)).toBeTruthy();
      expect(screen.queryByTestId('linked-pending-row')).toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    },
  );

  it('is operable from the keyboard: arrows move, Enter picks', async () => {
    routedFetch({
      [READ]: () => json(dto([])),
      [SEARCH]: () =>
        json([
          { ...cand('w1', 'PROD-1', 'First'), status: 'todo' },
          { ...cand('w2', 'PROD-2', 'Second'), status: 'todo' },
        ]),
      'POST /api/work-items/w2/pages': () =>
        json({ pageId: 'pg_1', workItemId: 'w2', source: 'manual' }),
    });
    mount(true);
    const { input, type } = await openPicker();
    type();
    await screen.findByRole('option', { name: /Second/ });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Second/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('linked-pending-row')).toBeTruthy();
  });
});

describe('Unlink', () => {
  it('removes the row at once and sends the DELETE', async () => {
    const fn = routedFetch({
      [READ]: () => json(dto([live('a', 'PROD-1', 'One'), live('b', 'PROD-2', 'Two')])),
      'DELETE /api/work-items/a/pages/pg_1': () => new Response(null, { status: 204 }),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink PROD-1' }));
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Two')).toBeTruthy();
    await waitFor(() =>
      expect(
        fn.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE'),
      ).toBe(true),
    );
  });

  it('restores the row in its original position on failure, and a retry re-sends the same pair', async () => {
    let ok = false;
    routedFetch({
      [READ]: () => json(dto([live('a', 'PROD-1', 'One'), live('b', 'PROD-2', 'Two')])),
      'DELETE /api/work-items/a/pages/pg_1': () =>
        ok ? new Response(null, { status: 204 }) : json({ code: 'BOOM' }, 500),
    });
    mount(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink PROD-1' }));
    expect(await screen.findByText(/Couldn’t unlink that work item/)).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('One');
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('One')).toBeNull());
  });
});

describe('zh', () => {
  it('renders the strip from the zh catalogue', async () => {
    routedFetch({ [READ]: () => json(dto([])) });
    mount(true, { messages: zh as unknown as Record<string, unknown> });
    expect(await screen.findByText('还没有手动关联的工作项。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关联工作项' })).toBeTruthy();
  });
});
