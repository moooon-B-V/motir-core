// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PageView, type PageViewPage } from '@/app/(authed)/pages/[pageId]/_components/PageView';
import type { PageVersionListItemDto } from '@/lib/dto/pages';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// PageView's own ⋯ and the archived banner read the router (MOTIR-7423).
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.search,
}));

// The page's HISTORY PANEL (Story MOTIR-5754 · MOTIR-7387) —
// `design/pages/page--history.mock.html` states 2–7 and 14, driven under
// happy-dom with the REAL `<PageEditor>` behind the REAL host, for the live page
// AND for the version shown beside it. Only `fetch` is stubbed: the panel is a
// pure client of `GET /api/pages/<id>/versions` and `GET …/versions/<n>`.

const EMPTY_STATE = 'AAA=';
/** One paragraph: "Tag the commit, then push the tag." */
const BODY_STATE =
  'AQONzd2iCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAI3N3aILAAYEAI3N3aILASJUYWcgdGhlIGNvbW1pdCwgdGhlbiBwdXNoIHRoZSB0YWcuAA==';

const VIEWER = 'user-ada';

type Answer = Response | Error | Promise<Response>;
const answers: Record<string, Answer[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  const key = Object.keys(answers).find((suffix) => url.endsWith(suffix));
  const next = key ? answers[key]!.shift() : undefined;
  if (!next) throw new Error(`unanswered fetch: ${url}`);
  if (next instanceof Error) throw next;
  return next;
});

function answer(suffix: string, ...responses: Answer[]) {
  (answers[suffix] ??= []).push(...responses);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

const MINUTE = 60_000;
function version(
  number: number,
  over: Partial<PageVersionListItemDto> = {},
): PageVersionListItemDto {
  const savedAt = new Date(Date.now() - number * MINUTE).toISOString();
  return {
    number,
    authorId: 'user-grace',
    authorName: 'Grace Hopper',
    startedAt: savedAt,
    savedAt,
    restoredFromNumber: null,
    restoredFromKept: false,
    isCurrent: false,
    ...over,
  };
}

const THREE = {
  items: [
    version(3, { isCurrent: true, authorId: VIEWER, authorName: 'Ada Lovelace' }),
    version(2),
    version(1, { savedAt: '2026-09-01T09:30:00.000Z' }),
  ],
  nextBefore: null,
};

async function mount(page: Partial<PageViewPage> = {}) {
  const utils = renderWithIntl(
    <Suspense fallback={<p>frame</p>}>
      <PageView
        page={{ id: 'page-1', title: 'Runbook', bodyState: BODY_STATE, canEdit: true, ...page }}
        viewerId={VIEWER}
        titleMaxLength={255}
      />
    </Suspense>,
  );
  const surface = await screen.findByRole('textbox', { name: 'Page body' });
  await act(async () => {});
  return { ...utils, surface };
}

const historyButton = () => screen.getByRole('button', { name: 'History' });
const list = () => screen.findByRole('list', { name: 'Versions of this page' });

beforeEach(() => {
  nav.search = new URLSearchParams();
  for (const key of Object.keys(answers)) delete answers[key];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the History control', () => {
  it('opens the panel listing v3 (Current), v2 and v1 with their authors and times', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    await mount();
    expect(historyButton()?.getAttribute('aria-expanded')).toBe('false');
    expect(historyButton()?.getAttribute('aria-controls')).toBe('page-history');

    fireEvent.click(historyButton());
    expect(historyButton()?.getAttribute('aria-expanded')).toBe('true');
    // The loading state paints first: six skeleton rows and one polite status.
    expect(screen.getByText('Loading history').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('page-history-skeleton').children).toHaveLength(6);

    const rows = within(await list()).getAllByRole('button');
    expect(rows.map((row) => within(row).getByText(/^Version \d+$/).textContent)).toEqual([
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    expect(rows[0]?.getAttribute('aria-current')).toBe('true');
    expect(within(rows[0]!).getByText('Current')).toBeTruthy();
    expect(within(rows[1]!).queryByText('Current')).toBeNull();
    // The reader's own version reads "You"; another author reads their name.
    expect(within(rows[0]!).getByText('You')).toBeTruthy();
    expect(within(rows[1]!).getByText('Grace Hopper')).toBeTruthy();
    // Relative under 24 hours, absolute after.
    expect(within(rows[1]!).getByText('2 minutes ago')).toBeTruthy();
    const old = rows[2]!.querySelector('time')!;
    expect(old?.getAttribute('dateTime')).toBe('2026-09-01T09:30:00.000Z');
    expect(old.textContent).toMatch(/2026/);
    // Focus moved into the panel.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close history' }));
  });

  it('a viewer gets the same control and the same list', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    await mount({ canEdit: false });
    expect(screen.getByRole('heading', { level: 1, name: 'Runbook' })).toBeTruthy();
    fireEvent.click(historyButton());
    expect(within(await list()).getAllByRole('button')).toHaveLength(3);
  });

  it('pressing History again closes the panel', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    await mount();
    fireEvent.click(historyButton());
    await list();
    fireEvent.click(historyButton());
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(historyButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a page with one version says so', async () => {
    answer(
      '/api/pages/page-1/versions',
      json({ items: [version(1, { isCurrent: true })], nextBefore: null }),
    );
    await mount();
    fireEvent.click(historyButton());
    await list();
    expect(
      screen.getByText('This is the only version so far. Each editing session adds one.'),
    ).toBeTruthy();
  });
});

describe('paging', () => {
  it('Load more sends before=nextBefore and appends the next page; none shows once it is null', async () => {
    answer(
      '/api/pages/page-1/versions',
      json({ items: [version(3, { isCurrent: true }), version(2)], nextBefore: 2 }),
    );
    answer('/api/pages/page-1/versions?before=2', json({ items: [version(1)], nextBefore: null }));
    await mount();
    fireEvent.click(historyButton());
    await list();
    expect(screen.getByText(en.pages.history.keepsLatest)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(3),
    );
    expect(calls('/versions?before=2')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a failed Load more keeps the rows and offers Try again', async () => {
    answer(
      '/api/pages/page-1/versions',
      json({ items: [version(3, { isCurrent: true }), version(2)], nextBefore: 2 }),
    );
    answer(
      '/api/pages/page-1/versions?before=2',
      json({ code: 'INTERNAL' }, 500),
      json({ items: [version(1)], nextBefore: null }),
    );
    await mount();
    fireEvent.click(historyButton());
    await list();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert?.textContent).toContain('Couldn’t load the history.');
    expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2);
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(3),
    );
  });
});

describe('a failed list', () => {
  it('shows the inline error, and Try again re-requests and shows the rows', async () => {
    answer('/api/pages/page-1/versions', new Error('offline'), json(THREE));
    await mount();
    fireEvent.click(historyButton());
    const alert = await screen.findByRole('alert');
    expect(alert?.textContent).toContain('Couldn’t load the history.');
    expect(screen.queryByRole('list')).toBeNull();

    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    expect(within(await list()).getAllByRole('button')).toHaveLength(3);
    expect(calls('/api/pages/page-1/versions')).toHaveLength(2);
  });
});

describe('a restore row', () => {
  it('reads "Restored from v2 (no longer kept)" when its source was pruned', async () => {
    answer(
      '/api/pages/page-1/versions',
      json({
        items: [
          version(4, { isCurrent: true, restoredFromNumber: 2, restoredFromKept: false }),
          version(3, { restoredFromNumber: 1, restoredFromKept: true }),
        ],
        nextBefore: null,
      }),
    );
    await mount();
    fireEvent.click(historyButton());
    const rows = within(await list()).getAllByRole('button');
    expect(rows[0]?.textContent).toContain('Restored from v2 (no longer kept)');
    expect(rows[1]?.textContent).toContain('Restored from v1');
    expect(rows[1]?.textContent).not.toContain('no longer kept');
  });
});

describe('a version shown beside the page', () => {
  it('renders v1 read-only beside the live editor, which stays editable', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json({ ...THREE.items[2], bodyState: BODY_STATE }));
    const { surface } = await mount({ bodyState: EMPTY_STATE });
    fireEvent.click(historyButton());
    const row = within(await list()).getAllByRole('button')[2]!;
    fireEvent.click(row);
    expect(row?.getAttribute('aria-pressed')).toBe('true');

    const region = screen.getByRole('region', { name: 'Comparing v1 with the current page' });
    expect(within(region).getByText('Current page')).toBeTruthy();
    const view = screen.getByTestId('page-version-view');
    await within(view).findByText('Tag the commit, then push the tag.');
    expect(view.querySelector('[contenteditable="true"]')).toBeNull();
    expect(within(view).getByText('Grace Hopper')).toBeTruthy();

    // The live editor is the same element, still writable, and holds its own doc.
    expect(screen.getAllByRole('textbox', { name: 'Page body' })[0]).toBe(surface);
    expect(surface?.getAttribute('contenteditable')).toBe('true');
    expect(surface?.textContent).not.toContain('Tag the commit');

    // Esc closes compare first; the panel stays.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('page-version-view')).toBeNull();
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(screen.getAllByRole('textbox', { name: 'Page body' })[0]).toBe(surface);
  });

  it('pressing the Current row shows no compare', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    await mount();
    fireEvent.click(historyButton());
    fireEvent.click(within(await list()).getAllByRole('button')[0]!);
    expect(screen.queryByTestId('page-version-view')).toBeNull();
  });

  it('a 404 PAGE_VERSION_NOT_FOUND shows the "no longer kept" message and re-reads the list', async () => {
    answer(
      '/api/pages/page-1/versions',
      json(THREE),
      json({ items: THREE.items.slice(0, 2), nextBefore: null }),
    );
    answer('/api/pages/page-1/versions/1', json({ code: 'PAGE_VERSION_NOT_FOUND' }, 404));
    await mount();
    fireEvent.click(historyButton());
    fireEvent.click(within(await list()).getAllByRole('button')[2]!);

    const alert = await screen.findByRole('alert');
    expect(alert?.textContent).toContain(
      'v1 is no longer kept — a page keeps its latest 100 versions. Nothing was changed, and the list has been refreshed.',
    );
    await waitFor(() =>
      expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2),
    );
    expect(calls('/api/pages/page-1/versions')).toHaveLength(2);
    expect(screen.queryByTestId('page-version-view')).toBeNull();
  });

  it('a failed version read offers Try again', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer(
      '/api/pages/page-1/versions/2',
      json({ code: 'INTERNAL' }, 500),
      json({ ...THREE.items[1], bodyState: BODY_STATE }),
    );
    await mount({ bodyState: EMPTY_STATE });
    fireEvent.click(historyButton());
    fireEvent.click(within(await list()).getAllByRole('button')[1]!);
    const view = screen.getByTestId('page-version-view');
    const alert = await within(view).findByRole('alert');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    });
    await within(view).findByText('Tag the commit, then push the tag.');
  });
});

describe('edges', () => {
  it('a version by the reader reads "You", and an author with no name gets a placeholder avatar', async () => {
    const mine = version(2, { authorId: VIEWER, authorName: 'Ada Lovelace' });
    answer(
      '/api/pages/page-1/versions',
      json({ items: [version(3, { isCurrent: true, authorName: '' }), mine], nextBefore: null }),
    );
    answer('/api/pages/page-1/versions/2', json({ ...mine, bodyState: BODY_STATE }));
    await mount({ bodyState: EMPTY_STATE });
    fireEvent.click(historyButton());
    const rows = within(await list()).getAllByRole('button');
    expect(rows[0]!.querySelector('[aria-hidden="true"]')?.textContent).toBe('?');
    fireEvent.click(rows[1]!);
    const view = screen.getByTestId('page-version-view');
    await within(view).findByText('Tag the commit, then push the tag.');
    expect(within(view).getByText('You')).toBeTruthy();
    // Closing compare by its own button keeps the panel.
    fireEvent.click(within(view).getByRole('button', { name: 'Close v2' }));
    expect(screen.queryByTestId('page-version-view')).toBeNull();
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('a 404 that is not PAGE_VERSION_NOT_FOUND is an ordinary failure', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/2', json({ code: 'PAGE_NOT_FOUND' }, 404));
    await mount();
    fireEvent.click(historyButton());
    fireEvent.click(within(await list()).getAllByRole('button')[1]!);
    const view = screen.getByTestId('page-version-view');
    expect((await within(view).findByRole('alert')).textContent).toContain(
      'Couldn’t load the history.',
    );
    expect(calls('/api/pages/page-1/versions')).toHaveLength(1);
  });

  it('answers that land after the panel or the version closed are dropped', async () => {
    let releaseList!: (res: Response) => void;
    let releaseVersion!: (res: Response) => void;
    answer(
      '/api/pages/page-1/versions',
      new Promise<Response>((resolve) => (releaseList = resolve)),
      json(THREE),
    );
    answer(
      '/api/pages/page-1/versions/2',
      new Promise<Response>((resolve) => (releaseVersion = resolve)),
    );
    await mount();
    fireEvent.click(historyButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => releaseList(json({ code: 'INTERNAL' }, 500)));
    expect(screen.queryByRole('complementary')).toBeNull();

    fireEvent.click(historyButton());
    fireEvent.click(within(await list()).getAllByRole('button')[1]!);
    expect(screen.getByTestId('page-version-loading')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => releaseVersion(json({ ...THREE.items[1], bodyState: BODY_STATE })));
    expect(screen.queryByTestId('page-version-view')).toBeNull();
  });
});

describe('decisions (Story MOTIR-5761 · MOTIR-7436, delta 5)', () => {
  it('a version a decision holds carries a tag linking to its card; frozen and published read apart', async () => {
    answer(
      '/api/pages/page-1/versions',
      json({
        items: [
          version(3, { isCurrent: true }),
          version(2, { decisionTag: { kind: 'frozen', key: 'ACME-12' } }),
          version(1, { decisionTag: { kind: 'published', key: 'ACME-9' } }),
        ],
        nextBefore: null,
      }),
    );
    await mount();
    fireEvent.click(historyButton());
    await list();
    const frozen = screen.getByRole('link', {
      name: en.pages.history.tag.frozenLabel.replace(/\{key\}/g, 'ACME-12'),
    });
    expect(frozen.getAttribute('href')).toBe('/items/ACME-12');
    expect(frozen.textContent).toContain(en.pages.history.tag.frozen);
    const published = screen.getByRole('link', {
      name: en.pages.history.tag.publishedLabel.replace(/\{key\}/g, 'ACME-9'),
    });
    expect(published.getAttribute('href')).toBe('/items/ACME-9');
    expect(screen.getAllByTestId(/^page-version-tag-/)).toHaveLength(2);
  });

  it('a ?version= link opens History on that version beside the page', async () => {
    nav.search = new URLSearchParams('version=1');
    answer('/api/pages/page-1/versions', json(THREE));
    answer('/api/pages/page-1/versions/1', json({ ...THREE.items[2], bodyState: BODY_STATE }));
    await mount({ bodyState: EMPTY_STATE });
    expect(historyButton()?.getAttribute('aria-expanded')).toBe('true');
    const view = await screen.findByTestId('page-version-view');
    await within(view).findByText('Tag the commit, then push the tag.');
  });
});

describe('closing', () => {
  it('Esc closes the panel and returns focus to the History control', async () => {
    answer('/api/pages/page-1/versions', json(THREE));
    await mount();
    fireEvent.click(historyButton());
    await list();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(historyButton());
  });

  it('the close button and the scrim close it', async () => {
    answer('/api/pages/page-1/versions', json(THREE), json(THREE));
    await mount();
    fireEvent.click(historyButton());
    await list();
    fireEvent.click(screen.getByRole('button', { name: 'Close history' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(historyButton());
    await list();
    fireEvent.click(screen.getByTestId('page-history-scrim'));
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});

describe('copy', () => {
  it('every pages.history key exists in en and zh with the same shape', () => {
    const keys = (node: object, prefix = ''): string[] =>
      Object.entries(node).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(zh.pages.history).sort()).toEqual(keys(en.pages.history).sort());
  });
});
