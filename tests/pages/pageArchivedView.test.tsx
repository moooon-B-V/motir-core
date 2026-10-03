// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';
import { ToastProvider } from '@/components/ui/Toast';

// THE PAGE ROUTE'S ARCHIVE SURFACES (Story MOTIR-5755 · MOTIR-7423) — design
// MOTIR-7416 surfaces 2, 5, 6, 7 and 8: the page's own ⋯ with Archive…, the
// archived banner (root and sub-page variants, actions by role), Restore and its
// toasts by landing, the permanent-delete confirm, History's read-only line, and
// the editor stopping for good when a save meets `PAGE_ARCHIVED`.
//
// The REAL `PageView` behind the REAL editor host, as the sibling suites run it.
// Stubbed: `fetch` (the doors answer as the routes do) and the router.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { PageView, type PageViewPage } from '@/app/(authed)/pages/[pageId]/_components/PageView';

/** One paragraph: "Tag the commit, then push the tag." */
const BODY_STATE =
  'AQONzd2iCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAI3N3aILAAYEAI3N3aILASJUYWcgdGhlIGNvbW1pdCwgdGhlbiBwdXNoIHRoZSB0YWcuAA==';
const NOW = new Date('2026-10-03T12:00:00.000Z');

type Answer = Response | Error;
const answers: Record<string, Answer[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input)}`;
  const next = answers[key]?.shift();
  if (!next) throw new Error(`unanswered fetch: ${key}`);
  if (next instanceof Error) throw next;
  return next;
});
function answer(key: string, ...responses: Answer[]) {
  (answers[key] ??= []).push(...responses);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sent = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}` === key,
  );

type Archived = NonNullable<PageViewPage['archived']>;
const ROOT_ARCHIVE: Archived = {
  archivedAt: '2026-10-03T11:00:00.000Z',
  archivedBy: { name: 'Grace Hopper' },
  archiveRoot: { id: 'page-1', title: 'Runbook' },
  canRestore: true,
  canDelete: true,
  subPageCount: 2,
};

async function mount(page: Partial<PageViewPage> = {}) {
  renderWithIntl(
    <ToastProvider>
      <Suspense fallback={<p>frame</p>}>
        <PageView
          page={{
            id: 'page-1',
            title: 'Runbook',
            bodyState: BODY_STATE,
            canEdit: true,
            parentTitle: 'Ops',
            ...page,
          }}
          viewerId="user-1"
          titleMaxLength={255}
        />
      </Suspense>
    </ToastProvider>,
    { now: NOW },
  );
  await screen.findByRole('textbox', { name: 'Page body' });
  await act(async () => {});
}

const archivedPage = (over: Partial<Archived> = {}): Partial<PageViewPage> => ({
  canEdit: false,
  archived: { ...ROOT_ARCHIVE, ...over },
});
const banner = () => screen.getByTestId('page-archived-banner');

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

clearToastTimersAfterEach();

afterEach(() => {
  cleanup();
  push.mockReset();
  refresh.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the page’s own ⋯ (surface 2)', () => {
  it('an editor of a live page has Page actions holding Archive… alone; no banner', async () => {
    await mount();
    expect(screen.queryByTestId('page-archived-banner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page actions for Runbook' }));
    const menu = await screen.findByRole('menu', { name: 'Page actions for Runbook' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['Archive…']);
  });

  it('a viewer has no ⋯', async () => {
    await mount({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Page actions for Runbook' })).toBeNull();
  });

  it('Archive… with sub-pages confirms, archives, re-reads the page and offers Undo', async () => {
    answer('GET /api/pages/page-1/archive', json({ subPageCount: 1, subPageTitles: ['Deploy'] }));
    answer(
      'POST /api/pages/page-1/archive',
      json({ archivedIds: ['page-1', 'p2'], rootId: 'page-1', subPageCount: 1 }),
    );
    answer(
      'DELETE /api/pages/page-1/archive',
      json({
        restoredIds: ['page-1', 'p2'],
        landing: { kind: 'original', parentPageId: null, folderId: null, title: null },
      }),
    );
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Page actions for Runbook' }));
    const menu = await screen.findByRole('menu', { name: 'Page actions for Runbook' });
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive…' }));
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Archive “Runbook” and its 1 sub-page?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Archive 2 pages' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Archived “Runbook” and 1 sub-page')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    expect(sent('DELETE /api/pages/page-1/archive')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Restored “Runbook” and 1 sub-page')).toBeTruthy();
  });

  it('a page already archived elsewhere says so and re-reads', async () => {
    answer('GET /api/pages/page-1/archive', json({ subPageCount: 0, subPageTitles: [] }));
    answer('POST /api/pages/page-1/archive', json({ code: 'PAGE_ARCHIVED' }, 409));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Page actions for Runbook' }));
    const menu = await screen.findByRole('menu', { name: 'Page actions for Runbook' });
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive…' }));
    });
    expect(await screen.findByText('“Runbook” is already archived')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the archived banner (surface 5)', () => {
  it('a Manager on the root: who, when, the sub-pages, the hint, Restore and Delete…', async () => {
    await mount(archivedPage());
    const b = banner();
    expect(b.getAttribute('role')).toBe('status');
    expect(b.textContent).toContain('This page is archived');
    expect(b.textContent).toContain('Archived by Grace Hopper · 1 hour ago');
    expect(b.textContent).toContain('Its 2 sub-pages were archived with it.');
    expect(b.textContent).toContain('Restore it to bring it back where it was.');
    expect(within(b).getByRole('button', { name: 'Restore “Runbook”' })).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Delete…' })).toBeTruthy();
    // Read-only: no editable title, no ⋯.
    expect(screen.queryByRole('textbox', { name: 'Page title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Page actions for Runbook' })).toBeNull();
  });

  it('a Member gets Restore only; a Viewer no actions and no hint', async () => {
    await mount(archivedPage({ canDelete: false }));
    expect(within(banner()).getByRole('button', { name: 'Restore “Runbook”' })).toBeTruthy();
    expect(within(banner()).queryByRole('button', { name: 'Delete…' })).toBeNull();
    cleanup();

    await mount(archivedPage({ canRestore: false, canDelete: false, subPageCount: 0 }));
    expect(within(banner()).queryAllByRole('button')).toHaveLength(0);
    expect(banner().textContent).not.toContain('Restore it to bring it back');
    expect(banner().textContent).not.toContain('sub-page');
  });

  it('an old archive shows the date, and an unknown archiver the placeholder', async () => {
    await mount(archivedPage({ archivedAt: '2026-09-01T09:30:00.000Z', archivedBy: null }));
    expect(banner().textContent).toContain('Archived by a former member · Sep 1, 2026');
  });

  it('a sub-page that left with its root names the root and links to it', async () => {
    await mount(archivedPage({ archiveRoot: { id: 'root-1', title: 'Ops' }, subPageCount: 0 }));
    const b = banner();
    expect(b.textContent).toContain('This page was archived with “Ops”');
    expect(b.textContent).toContain('Restore “Ops” to bring it back.');
    const link = within(b).getByRole('link', { name: 'Open “Ops”' });
    expect(link.getAttribute('href')).toBe('/pages/root-1');
    expect(within(b).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('Restore from the banner (surface 6)', () => {
  const restoreButton = () => within(banner()).getByRole('button', { name: 'Restore “Runbook”' });
  const restoreAnswer = (landing: object, ids = ['page-1', 'a', 'b']) =>
    json({
      restoredIds: ids,
      landing: { parentPageId: null, folderId: null, title: null, ...landing },
    });

  it('to its original place: one DELETE, the page re-reads, the toast counts', async () => {
    answer('DELETE /api/pages/page-1/archive', restoreAnswer({ kind: 'original' }));
    await mount(archivedPage());
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(sent('DELETE /api/pages/page-1/archive')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Restored “Runbook” and 2 sub-pages')).toBeTruthy();
  });

  it('under an ancestor, or into a folder, says where and why', async () => {
    answer(
      'DELETE /api/pages/page-1/archive',
      restoreAnswer({ kind: 'ancestorPage', title: 'Handbook' }),
      restoreAnswer({ kind: 'folder', title: 'Specs' }),
    );
    await mount(archivedPage());
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(
      await screen.findByText('Restored under “Handbook”, because “Ops” is archived.'),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(
      await screen.findByText(
        'Restored into the folder “Specs”, because “Ops” and the pages above it are archived.',
      ),
    ).toBeTruthy();
  });

  it('restored elsewhere already: re-reads without a toast; a failure toasts and stays', async () => {
    answer(
      'DELETE /api/pages/page-1/archive',
      json({ code: 'PAGE_NOT_ARCHIVED' }, 409),
      json({ code: 'X' }, 500),
    );
    await mount(archivedPage());
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(restoreButton());
    });
    expect(await screen.findByText('Couldn’t restore “Runbook”. Try again.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a sub-page restored directly is refused with the way to its root', async () => {
    const { useRestorePage } = await import('@/components/pages/archive/useRestorePage');
    answer(
      'DELETE /api/pages/sub-1/archive',
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED', rootId: 'root-1' }, 409),
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED', rootId: 'root-1' }, 409),
    );
    function Probe({ rootTitle }: { rootTitle?: string }) {
      const { restore } = useRestorePage();
      return (
        <button onClick={() => void restore({ id: 'sub-1', title: 'Deploy', rootTitle })}>
          go
        </button>
      );
    }
    renderWithIntl(
      <ToastProvider>
        <Probe rootTitle="Ops" />
      </ToastProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'go' }));
    });
    expect(await screen.findByText('Couldn’t restore “Deploy”')).toBeTruthy();
    expect(
      screen.getByText('“Deploy” is archived as part of “Ops”. Restore “Ops” to bring it back.'),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open “Ops”' }));
    });
    expect(push).toHaveBeenCalledWith('/pages/root-1');
  });
});

describe('Delete… — the permanent-delete confirm (surface 7)', () => {
  async function openDelete(over: Partial<Archived> = {}) {
    await mount(archivedPage(over));
    fireEvent.click(within(banner()).getByRole('button', { name: 'Delete…' }));
    return screen.findByRole('alertdialog');
  }

  it('states the magnitude; success toasts and goes to /pages', async () => {
    answer(
      'DELETE /api/pages/page-1',
      json({ deletedIds: ['page-1', 'a', 'b'], rootId: 'page-1', subPageCount: 2 }),
    );
    const dialog = await openDelete();
    expect(dialog.textContent).toContain('Delete “Runbook” permanently?');
    expect(dialog.textContent).toContain('This can’t be undone.');
    expect(dialog.textContent).toContain('3 pages will be deleted.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 3 pages' }));
    });
    expect(sent('DELETE /api/pages/page-1')).toHaveLength(1);
    expect(push).toHaveBeenCalledWith('/pages');
    expect(await screen.findByText('Deleted “Runbook” and 2 sub-pages')).toBeTruthy();
  });

  it('a page with no sub-pages says so and reads Delete page', async () => {
    answer(
      'DELETE /api/pages/page-1',
      json({ deletedIds: ['page-1'], rootId: 'page-1', subPageCount: 0 }),
    );
    const dialog = await openDelete({ subPageCount: 0 });
    expect(dialog.textContent).toContain('It has no sub-pages.');
    expect(dialog.textContent).toContain('1 page will be deleted.');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    });
    expect(await screen.findByText('Deleted “Runbook”')).toBeTruthy();
  });

  it('a failure keeps the dialog with the callout, and the action retries', async () => {
    answer('DELETE /api/pages/page-1', new TypeError('Failed to fetch'));
    const dialog = await openDelete();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 3 pages' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Couldn’t delete “Runbook”. Nothing was deleted — try again.',
    );
    expect(push).not.toHaveBeenCalled();
    const retry = within(dialog).getByRole('button', { name: 'Delete 3 pages' });
    expect(retry.hasAttribute('disabled')).toBe(false);
  });

  it('restored meanwhile: says so, disables the action and re-reads', async () => {
    answer('DELETE /api/pages/page-1', json({ code: 'PAGE_NOT_ARCHIVED' }, 409));
    const dialog = await openDelete();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 3 pages' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toContain(
      '“Runbook” isn’t archived any more — someone restored it — so it can’t be deleted.',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Delete 3 pages' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes and sends nothing', async () => {
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sent('DELETE /api/pages/page-1')).toHaveLength(0);
  });
});

describe('History on an archived page (surface 8)', () => {
  const VERSIONS = {
    items: [
      {
        number: 2,
        authorId: 'u',
        authorName: 'Grace Hopper',
        startedAt: '2026-10-03T10:00:00.000Z',
        savedAt: '2026-10-03T10:00:00.000Z',
        restoredFromNumber: null,
        restoredFromKept: false,
        isCurrent: true,
      },
      {
        number: 1,
        authorId: 'u',
        authorName: 'Grace Hopper',
        startedAt: '2026-10-03T09:00:00.000Z',
        savedAt: '2026-10-03T09:00:00.000Z',
        restoredFromNumber: null,
        restoredFromKept: false,
        isCurrent: false,
      },
    ],
    nextBefore: null,
  };

  async function compareV1() {
    answer('GET /api/pages/page-1/versions', json(VERSIONS));
    answer(
      'GET /api/pages/page-1/versions/1',
      json({ ...VERSIONS.items[1], bodyState: BODY_STATE }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const list = await screen.findByRole('list', { name: 'Versions of this page' });
    await act(async () => {
      fireEvent.click(within(list).getAllByRole('button')[1]!);
    });
    return screen.getByTestId('page-version-view');
  }

  it('versions read, Restore version is not drawn, and an editor is told why', async () => {
    await mount(archivedPage());
    const view = await compareV1();
    expect(within(view).queryByRole('button', { name: 'Restore this version' })).toBeNull();
    expect(view.textContent).toContain(
      'Versions of an archived page can be read, not restored. Restore the page first.',
    );
  });

  it('a Viewer gets no line', async () => {
    await mount(archivedPage({ canRestore: false, canDelete: false }));
    const view = await compareV1();
    expect(view.textContent).not.toContain('Versions of an archived page');
  });
});

describe('a save that meets PAGE_ARCHIVED (the editor stops)', () => {
  it('shows the archived callout and sends nothing more', async () => {
    answer('POST /api/pages/page-1/updates', json({ code: 'PAGE_ARCHIVED' }, 409));
    await mount();
    const surface = screen.getByRole('textbox', { name: 'Page body' });
    vi.useFakeTimers();
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This page was archived');
    expect(alert.getAttribute('data-refusal')).toBe('archived');
    expect(within(alert).queryByRole('button', { name: 'New page in a new tab' })).toBeNull();

    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Again.');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    vi.useRealTimers();
    expect(sent('POST /api/pages/page-1/updates')).toHaveLength(1);

    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
