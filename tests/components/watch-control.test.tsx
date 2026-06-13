// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { WatchersPageDto } from '@/lib/dto/watchers';
import { ToastProvider } from '@/components/ui/Toast';

// The watch control + watchers popover (Subtask 5.4.9), against
// design/work-items/labels-components-watch.mock.html panels 4–6. The Server
// Actions are stubbed (their service behaviour is covered by the 5.4.4
// suite); the control must reconcile from the ACTION RESPONSE — optimistic
// bump, rollback + toast on failure, NO router.refresh (the inline-edit
// rule). The paged roster read is a stubbed GET (the 5.4.4 list route).
const { toggleWatchSpy, addWatcherSpy, removeWatcherSpy } = vi.hoisted(() => ({
  toggleWatchSpy: vi.fn(),
  addWatcherSpy: vi.fn(),
  removeWatcherSpy: vi.fn(),
}));
vi.mock('@/app/(authed)/issues/[key]/watcherActions', () => ({
  toggleWatchAction: toggleWatchSpy,
  addWatcherAction: addWatcherSpy,
  removeWatcherAction: removeWatcherSpy,
}));

import {
  WatchControl,
  type WatchCandidate,
} from '@/app/(authed)/issues/[key]/_components/WatchControl';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const candidates: WatchCandidate[] = [
  { id: 'u_yue', name: 'Yue Zhu', email: 'zhuyue@motir.co' },
  { id: 'u_bo', name: 'Bo Philips', email: 'bophilips@motir.co' },
  { id: 'u_julian', name: 'Julian', email: 'julian@motir.co' },
];

function page(overrides: Partial<WatchersPageDto> = {}): WatchersPageDto {
  return {
    watchers: [
      { userId: 'u_yue', name: 'Yue Zhu', image: null },
      { userId: 'u_bo', name: 'Bo Philips', image: null },
    ],
    totalCount: 2,
    nextCursor: null,
    canManage: false,
    ...overrides,
  };
}

function stubWatchersList(first: WatchersPageDto, byCursor: Record<string, WatchersPageDto> = {}) {
  // Keyed off the request's cursor (NOT call order) — the control re-reads
  // the first window after a toggle commits, so call counts aren't stable.
  const fetchSpy = vi.fn().mockImplementation((url: string) => {
    const cursor = new URL(url, 'http://test').searchParams.get('cursor');
    const body = cursor ? (byCursor[cursor] ?? first) : first;
    return Promise.resolve({ ok: true, json: async () => body });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function renderControl(props: Partial<Parameters<typeof WatchControl>[0]> = {}) {
  return render(
    <ToastProvider>
      <WatchControl
        workItemId="wi_1"
        initialCount={3}
        initialWatching={false}
        currentUserId="u_yue"
        candidates={candidates}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('WatchControl — the eye + count toggle (panel 4)', () => {
  it('renders the not-watching state: outline, count, aria-pressed=false, the accessible name', () => {
    stubWatchersList(page());
    renderControl();
    const btn = screen.getByRole('button', { name: 'Watch — 3 watching' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.textContent).toContain('3');
  });

  it('click toggles optimistically (count bump + pressed) AND opens the roster, then reconciles from the response', async () => {
    stubWatchersList(page({ totalCount: 4 }));
    toggleWatchSpy.mockResolvedValue({ ok: true, watching: true, watcherCount: 4 });
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Watch — 3 watching' }));

    // Optimistic: pressed + bumped before the action resolves.
    const pressed = screen.getByRole('button', { name: /watching/i });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.textContent).toContain('4');

    // The same gesture opens the popover (the verification-recipe flow).
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Watchers' })).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Bo Philips')).toBeTruthy());
    expect(toggleWatchSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', watch: true });
  });

  it('a viewer toggles too — the control never gates on edit capability', async () => {
    stubWatchersList(page());
    toggleWatchSpy.mockResolvedValue({ ok: true, watching: true, watcherCount: 4 });
    renderControl();
    fireEvent.click(screen.getByRole('button', { name: 'Watch — 3 watching' }));
    await waitFor(() => expect(toggleWatchSpy).toHaveBeenCalled());
  });

  it('rolls the optimistic bump back (with the toast grammar) when the action fails', async () => {
    stubWatchersList(page());
    toggleWatchSpy.mockResolvedValue({ ok: false, error: 'Work item wi_1 not found.' });
    renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Watch — 3 watching' }));
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Watch — 3 watching' });
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.textContent).toContain('3');
    });
    expect(screen.getByText('Couldn’t update watching')).toBeTruthy();
  });

  it('W toggles self-watch without opening the popover', async () => {
    stubWatchersList(page());
    toggleWatchSpy.mockResolvedValue({ ok: true, watching: true, watcherCount: 4 });
    renderControl();

    fireEvent.keyDown(window, { key: 'w' });
    await waitFor(() =>
      expect(toggleWatchSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', watch: true }),
    );
    expect(screen.queryByRole('dialog', { name: 'Watchers' })).toBeNull();
  });

  it('W is ignored while typing in a text input (the standard guard)', () => {
    stubWatchersList(page());
    renderControl();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'w' });
    expect(toggleWatchSpy).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('WatchControl — the watchers popover (panel 5)', () => {
  async function openPopover() {
    toggleWatchSpy.mockResolvedValue({ ok: true, watching: true, watcherCount: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Watch — 3 watching' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Watchers' })).toBeTruthy());
  }

  it('marks your own row with the You pill and pages with "Show more"', async () => {
    stubWatchersList(page({ totalCount: 5, nextCursor: 'w_2' }), {
      w_2: page({
        watchers: [{ userId: 'u_mo', name: 'Mo', image: null }],
        totalCount: 5,
        nextCursor: null,
      }),
    });
    renderControl();
    await openPopover();

    await waitFor(() => expect(screen.getByText('You')).toBeTruthy());
    const more = await screen.findByRole('button', { name: 'Show more (3 more)' });
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText('Mo')).toBeTruthy());
    // Cursor consumed — the pager row is gone.
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('non-admins get the list only — no add row, no per-row remove', async () => {
    stubWatchersList(page({ canManage: false }));
    renderControl();
    await openPopover();

    await waitFor(() => expect(screen.getByText('Bo Philips')).toBeTruthy());
    expect(screen.queryByLabelText('Add a watcher…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Bo Philips from watchers' })).toBeNull();
  });

  it('admins add a watcher through the member-picker row, confirmed from the action response', async () => {
    stubWatchersList(page({ canManage: true }));
    addWatcherSpy.mockResolvedValue({
      ok: true,
      watcher: { userId: 'u_julian', name: 'Julian', image: null },
      watcherCount: 3,
    });
    renderControl();
    await openPopover();

    const search = await screen.findByLabelText('Add a watcher…');
    fireEvent.change(search, { target: { value: 'ju' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Julian' }));

    await waitFor(() =>
      expect(addWatcherSpy).toHaveBeenCalledWith({
        workItemId: 'wi_1',
        userId: 'u_julian',
        userName: 'Julian',
      }),
    );
    await waitFor(() => expect(screen.getByText('Julian')).toBeTruthy());
  });

  it('surfaces the typed no-view-access rejection INLINE (never a silent drop)', async () => {
    stubWatchersList(page({ canManage: true }));
    addWatcherSpy.mockResolvedValue({
      ok: false,
      error: 'Julian can’t view this work item, so they can’t watch it.',
    });
    renderControl();
    await openPopover();

    fireEvent.change(await screen.findByLabelText('Add a watcher…'), { target: { value: 'ju' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Julian' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Julian can’t view this work item, so they can’t watch it.',
    );
  });

  it('admins remove a watcher from the per-row ×', async () => {
    stubWatchersList(page({ canManage: true }));
    removeWatcherSpy.mockResolvedValue({ ok: true, watcherCount: 1 });
    renderControl();
    await openPopover();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bo Philips from watchers' }));
    await waitFor(() =>
      expect(removeWatcherSpy).toHaveBeenCalledWith({ workItemId: 'wi_1', userId: 'u_bo' }),
    );
    await waitFor(() => expect(screen.queryByText('Bo Philips')).toBeNull());
  });
});
