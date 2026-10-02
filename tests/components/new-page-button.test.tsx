// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { PageParentDto } from '@/lib/dto/pages';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';

// NEW PAGE (Story MOTIR-5752 · MOTIR-7300) — `design/pages/design-notes.md`
// § New page: rendered only for `page:edit`; one press POSTs `/api/pages` and
// moves to `/pages/<id>`; disabled with "Creating page…" while in flight; a
// failure is the shipped Toast and the button returns. `fetch` and the router
// are the only stubs — the route itself is `tests/api/pages*`'s.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import { NewPageButton } from '@/app/(authed)/pages/_components/NewPageButton';
import { NewFolderButton as PagesNewFolderButton } from '@/app/(authed)/pages/_components/NewFolderButton';
import { FolderCommandsProvider } from '@/components/folders/FolderCommands';

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function mount(permissions: PermissionKey[] = ['page:view', 'page:edit'], parent?: PageParentDto) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectAccessProvider permissions={permissions}>
        <NewPageButton parent={parent} />
      </ProjectAccessProvider>
    </ToastProvider>,
  );
}

/** A promise the test settles by hand, so the in-flight state can be observed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  push.mockReset();
  vi.unstubAllGlobals();
});

describe('NewPageButton', () => {
  it('is not rendered for a reader without `page:edit` — no disabled button either', () => {
    mount(['page:view']);
    expect(screen.queryByRole('button', { name: 'New page' })).toBeNull();
    expect(screen.queryByTestId('new-page-button')).toBeNull();
  });

  it('creates a page and moves to its address', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'pg_123' }, 201));
    mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/pages');
    expect(init?.method).toBe('POST');
    // No parent given: the project root (MOTIR-7373).
    expect(JSON.parse(String(init?.body))).toEqual({ parent: { kind: 'root' } });
    expect(push).toHaveBeenCalledWith('/pages/pg_123');
    // The browser is leaving: the button stays pending, so a second press cannot
    // create a second page.
    expect(screen.getByTestId('new-page-button')).toHaveProperty('disabled', true);
  });

  it('creates the page under the parent it is given (MOTIR-7373)', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'pg_7' }, 201));
    mount(undefined, { kind: 'folder', id: 'f-1' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ parent: { kind: 'folder', id: 'f-1' } });
    expect(push).toHaveBeenCalledWith('/pages/pg_7');
  });

  it('is disabled and reads "Creating page…" while the POST is in flight', async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValueOnce(answer.promise);
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const button = screen.getByTestId('new-page-button');
    expect(button.textContent).toContain('Creating page…');
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    // A second press while in flight sends nothing.
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer.resolve(json({ id: 'pg_9' }, 201));
    });
    expect(push).toHaveBeenCalledWith('/pages/pg_9');
  });

  it('the handler itself refuses a second create while one is in flight, not only the disabled attribute', async () => {
    // `fireEvent.click` on the disabled button above never reaches the handler —
    // React drops a click on a disabled control — so that case proves the
    // ATTRIBUTE. This one proves the handler's own `pending` guard (MOTIR-7281),
    // which is what stands if the control is ever re-enabled mid-flight: it calls
    // the press React would dispatch, on the re-rendered (pending) button.
    const answer = deferred<Response>();
    fetchMock.mockReturnValueOnce(answer.promise);
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const button = screen.getByTestId('new-page-button');
    const propsKey = Object.keys(button).find((k) => k.startsWith('__reactProps$'))!;
    const { onClick } = (button as unknown as Record<string, { onClick: () => Promise<void> }>)[
      propsKey
    ]!;
    await act(async () => {
      await onClick();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer.resolve(json({ id: 'pg_1' }, 201));
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a refused create is a toast, nothing navigates, and the button returns', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'PERMISSION_DENIED' }, 403));
    mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    });

    expect(push).not.toHaveBeenCalled();
    expect(await screen.findByText('Couldn’t create the page. Try again.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'New page' });
    expect(button).toHaveProperty('disabled', false);
  });

  it('a network failure is the same toast', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    });

    expect(push).not.toHaveBeenCalled();
    expect(await screen.findByText('Couldn’t create the page. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New page' })).toHaveProperty('disabled', false);
  });
});

// NEW FOLDER on `/pages` (Story MOTIR-5753 · MOTIR-7374): rendered only for a
// reader holding BOTH `page:edit` and `work_item:edit`, as the shared
// `NewRootFolderButton` inside the page's folder command channel.
describe('NewFolderButton (/pages)', () => {
  function mountFolder(permissions: PermissionKey[]) {
    return renderWithIntl(
      <ProjectAccessProvider permissions={permissions}>
        <FolderCommandsProvider>
          <PagesNewFolderButton />
        </FolderCommandsProvider>
      </ProjectAccessProvider>,
    );
  }

  it('renders New folder for a reader who may write pages AND folders', () => {
    mountFolder(['page:view', 'page:edit', 'work_item:edit']);
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
  });

  it.each([[['page:view', 'page:edit']], [['page:view', 'work_item:edit']]] as const)(
    'renders nothing without both keys (%j)',
    (permissions) => {
      mountFolder([...permissions]);
      expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    },
  );
});
