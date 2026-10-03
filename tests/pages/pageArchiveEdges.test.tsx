// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { ToastProvider } from '@/components/ui/Toast';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';

// THE ARCHIVE CLIENT'S EDGES (Story MOTIR-5755 · MOTIR-7423) — what the flow
// suites (`pageTreeArchive`, `pageArchivedView`) do not reach: the refusal map on
// bodies that are not JSON, the in-flight guards, the restore toast's Open, the
// confirms' Escape while a write runs, the create refusal with no parent title,
// and the save door's 409 that is NOT an archive.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import {
  archivePageRequest,
  deletePageRequest,
  readArchiveSet,
  restorePageRequest,
} from '@/components/pages/archive/archiveClient';
import { useRestorePage } from '@/components/pages/archive/useRestorePage';
import { useArchivePage, type ArchiveTarget } from '@/components/pages/archive/useArchivePage';
import { ArchivePageDialog } from '@/components/pages/archive/ArchivePageDialog';
import { DeletePageDialog } from '@/components/pages/archive/DeletePageDialog';
import { useCreatePage } from '@/components/pages/tree/useCreatePage';
import { sendPageUpdate } from '@/components/pages/PageEditorHost';

type Reply = Response | Error | Promise<Response>;
const queue: Record<string, Reply[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input)}`;
  const next = queue[key]?.shift();
  if (!next) throw new Error(`unanswered fetch: ${key}`);
  if (next instanceof Error) throw next;
  return next;
});
function reply(key: string, ...r: Reply[]) {
  (queue[key] ??= []).push(...r);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (body: string, status: number) => new Response(body, { status });
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <ToastProvider>{children}</ToastProvider>
  </NextIntlClientProvider>
);
const RESTORED = (landing: object) =>
  json({
    restoredIds: ['p1'],
    landing: { parentPageId: null, folderId: null, title: null, ...landing },
  });

beforeEach(() => {
  for (const key of Object.keys(queue)) delete queue[key];
  vi.stubGlobal('fetch', fetchMock);
});

clearToastTimersAfterEach();

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  push.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('archiveClient — the refusal map', () => {
  it('maps each code, a bare 404, a body that is not JSON and a lost connection', async () => {
    reply('GET /api/pages/p1/archive', text('not json', 404), new TypeError('offline'));
    reply('POST /api/pages/p1/archive', json({ code: 'PAGE_ARCHIVED' }, 409), text('<html>', 502));
    reply(
      'DELETE /api/pages/p1/archive',
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED' }, 409),
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED', rootId: 'r1' }, 409),
    );
    reply('DELETE /api/pages/a%2Fb', json({ code: 'PAGE_NOT_ARCHIVED' }, 409));

    expect(await readArchiveSet('p1')).toEqual({ ok: false, kind: 'gone' });
    expect(await readArchiveSet('p1')).toEqual({ ok: false, kind: 'failed' });
    expect(await archivePageRequest('p1')).toEqual({ ok: false, kind: 'alreadyArchived' });
    expect(await archivePageRequest('p1')).toEqual({ ok: false, kind: 'failed' });
    expect(await restorePageRequest('p1')).toEqual({
      ok: false,
      kind: 'rootRequired',
      rootId: null,
    });
    expect(await restorePageRequest('p1')).toEqual({
      ok: false,
      kind: 'rootRequired',
      rootId: 'r1',
    });
    expect(await deletePageRequest('a/b')).toEqual({ ok: false, kind: 'notArchived' });
  });
});

describe('useRestorePage', () => {
  it('a second restore of the same page while one runs is refused', async () => {
    const later = deferred();
    reply('DELETE /api/pages/p1/archive', later.promise);
    const { result } = renderHook(() => useRestorePage(), { wrapper });
    let first: Promise<unknown>;
    let second: unknown;
    await act(async () => {
      first = result.current.restore({ id: 'p1', title: 'Runbook' });
      second = await result.current.restore({ id: 'p1', title: 'Runbook' });
    });
    expect(second).toBeNull();
    expect(result.current.pendingId).toBe('p1');
    await act(async () => {
      later.resolve(RESTORED({ kind: 'original' }));
      await first;
    });
    expect(result.current.pendingId).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('off the page, the toast offers Open; an unnamed landing and parent read Untitled', async () => {
    reply('DELETE /api/pages/p1/archive', RESTORED({ kind: 'ancestorPage' }));
    const { result } = renderHook(() => useRestorePage({ showOpen: true }), { wrapper });
    await act(async () => {
      await result.current.restore({ id: 'p1', title: 'Runbook' });
    });
    expect(
      screen.getByText('Restored under “Untitled”, because “Untitled” is archived.'),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(push).toHaveBeenCalledWith('/pages/p1');
  });

  it('a root-required refusal with no root named or known offers nothing to open', async () => {
    reply(
      'DELETE /api/pages/p1/archive',
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED' }, 409),
      json({ code: 'PAGE_ARCHIVE_ROOT_REQUIRED', rootId: 'r1' }, 409),
    );
    const { result } = renderHook(() => useRestorePage(), { wrapper });
    await act(async () => {
      await result.current.restore({ id: 'p1', title: 'Deploy' });
    });
    expect(screen.getByText('Couldn’t restore “Deploy”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    // Knowing the root's id but not its title: a plain Open.
    await act(async () => {
      await result.current.restore({ id: 'p1', title: 'Deploy' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(push).toHaveBeenCalledWith('/pages/r1');
  });
});

describe('useArchivePage', () => {
  function Probe({
    target,
    onArchived = vi.fn(),
    onRestored = vi.fn(),
    onStale,
  }: {
    target: ArchiveTarget;
    onArchived?: () => void;
    onRestored?: () => void;
    onStale?: () => void;
  }) {
    const archive = useArchivePage({ onArchived, onRestored, onStale });
    const [confirmed, setConfirmed] = useState(0);
    return (
      <>
        <button onClick={() => archive.request(target)}>request</button>
        <span data-testid="pending">{archive.pendingId ?? 'none'}</span>
        {archive.confirm ? (
          <>
            <button
              onClick={() => {
                // Twice in one click: the second is refused while the first runs.
                archive.confirm!.onConfirm();
                archive.confirm!.onConfirm();
                setConfirmed((n) => n + 1);
              }}
            >
              confirm twice
            </button>
            <ArchivePageDialog {...archive.confirm} />
          </>
        ) : null}
        <span data-testid="confirmed">{confirmed}</span>
      </>
    );
  }
  // `hidden`: an open modal hides the probe's own buttons from the a11y tree.
  const press = async (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name, hidden: true }));
    });

  it('a second request while one runs is refused; a set that is gone re-reads', async () => {
    const later = deferred();
    reply('GET /api/pages/p1/archive', later.promise);
    const onStale = vi.fn();
    renderWithIntl(
      <ToastProvider>
        <Probe target={{ id: 'p1', title: 'Runbook' }} onStale={onStale} />
      </ToastProvider>,
    );
    await press('request');
    await press('request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pending').textContent).toBe('p1');
    await act(async () => {
      later.resolve(json({ code: 'PAGE_NOT_FOUND' }, 404));
    });
    expect(screen.getByText('Couldn’t archive “Runbook”. Try again.')).toBeTruthy();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pending').textContent).toBe('none');
  });

  it('confirming twice archives once; Escape is held while it runs; the dialog reads Archiving…', async () => {
    reply('GET /api/pages/p1/archive', json({ subPageCount: 1, subPageTitles: ['Deploy'] }));
    const later = deferred();
    reply('POST /api/pages/p1/archive', later.promise);
    renderWithIntl(
      <ToastProvider>
        <Probe target={{ id: 'p1', title: 'Runbook' }} />
      </ToastProvider>,
    );
    await press('request');
    await press('confirm twice');
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: /Archiving…/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(
      true,
    );
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => {
      later.resolve(json({ archivedIds: ['p1', 'p2'], rootId: 'p1', subPageCount: 1 }));
    });
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape cancels an idle confirm, sending nothing', async () => {
    reply('GET /api/pages/p1/archive', json({ subPageCount: 2, subPageTitles: ['A', 'B'] }));
    renderWithIntl(
      <ToastProvider>
        <Probe target={{ id: 'p1', title: 'Runbook' }} />
      </ToastProvider>,
    );
    await press('request');
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('pending').textContent).toBe('none');
  });

  it('a page gone by the archive re-reads; an Undo that fails restores nothing', async () => {
    reply(
      'POST /api/pages/p1/archive',
      json({ code: 'PAGE_NOT_FOUND' }, 404),
      json({ archivedIds: ['p1'], rootId: 'p1', subPageCount: 0 }),
    );
    reply('DELETE /api/pages/p1/archive', json({ code: 'X' }, 500));
    const onStale = vi.fn();
    const onRestored = vi.fn();
    renderWithIntl(
      <ToastProvider>
        <Probe
          target={{ id: 'p1', title: 'Runbook', hasChildren: false }}
          onStale={onStale}
          onRestored={onRestored}
        />
      </ToastProvider>,
    );
    await press('request');
    expect(onStale).toHaveBeenCalledTimes(1);
    await press('request');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    expect(screen.getByText('Couldn’t restore “Runbook”. Try again.')).toBeTruthy();
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe('DeletePageDialog — while it deletes', () => {
  it('reads Deleting…, holds Escape and Cancel, and Escape closes it once idle', async () => {
    const later = deferred();
    reply('DELETE /api/pages/p1', later.promise);
    const onClose = vi.fn();
    renderWithIntl(
      <ToastProvider>
        <DeletePageDialog
          page={{ id: 'p1', title: 'Runbook' }}
          subPageCount={0}
          onClose={onClose}
          onDeleted={vi.fn()}
        />
      </ToastProvider>,
    );
    const dialog = screen.getByRole('alertdialog');
    const action = within(dialog).getByRole('button', { name: 'Delete page' });
    await act(async () => {
      // A double click: one DELETE.
      action.click();
      action.click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: /Deleting…/ })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      later.resolve(json({ code: 'X' }, 500));
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('useCreatePage — refusals', () => {
  it('an archived parent with no title known reads Untitled; a body that is not JSON is the plain failure', async () => {
    reply('POST /api/pages', json({ code: 'PAGE_PARENT_ARCHIVED' }, 422), text('<html>', 502));
    const { result } = renderHook(() => useCreatePage(), { wrapper });
    await act(async () => {
      await result.current.create({ kind: 'page', id: 'p1' });
    });
    expect(
      screen.getByText(
        '“Untitled” is archived, so nothing can be added under it. Nothing was changed.',
      ),
    ).toBeTruthy();
    await act(async () => {
      await result.current.create({ kind: 'root' });
    });
    expect(screen.getByText('Couldn’t create the page. Try again.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('sendPageUpdate — a 409 that is not an archive', () => {
  it('stays a plain, retryable rejection', async () => {
    reply(
      'POST /api/pages/p/updates',
      json({ code: 'SOMETHING_ELSE' }, 409),
      text('conflict', 409),
    );
    for (let i = 0; i < 2; i++) {
      const refusal = await sendPageUpdate('p', new Uint8Array([1])).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as { code?: string }).code).toBeUndefined();
      expect((refusal as Error).message).toContain('409');
    }
  });
});
