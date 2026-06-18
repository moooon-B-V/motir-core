// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { NotificationsPageDTO } from '@/lib/dto/notifications';

// NotificationDrawer (Subtask 5.7.5) — the Watching-tab regression guard for bug
// 8.8.1. The tab was hardcoded `disabled` as the Story 5.4 seam; with 5.4
// issue-watching shipped and 5.7.10 wiring the `watching` fan-in, the seam is
// open. This asserts: (1) the Watching tab is ENABLED, and (2) each Segmented
// tab shows its OWN category-scoped unread count (from `unreadByCategory`), not
// the global total the bell badge owns. Component test, real `en` catalog, no
// jest-dom (the happy-dom convention).

beforeAll(() => {
  // Radix Popover (the overflow menu) probes APIs happy-dom omits, even closed.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

import { NotificationDrawer } from '@/app/(authed)/_components/NotificationDrawer';

function pageDTO(over: Partial<NotificationsPageDTO> = {}): NotificationsPageDTO {
  return {
    notifications: [],
    totalCount: 0,
    // Global total (5) ≠ either per-tab count — so a tab badge showing 5 is the bug.
    unreadCount: 5,
    unreadByCategory: { direct: 2, watching: 3 },
    nextCursor: null,
    ...over,
  };
}

function renderDrawer(page: NotificationsPageDTO = pageDTO()) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      ({ ok: true, json: async () => page }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  const onCountChange = vi.fn();
  const utils = render(
    <ToastProvider>
      <NotificationDrawer unreadCount={5} onCountChange={onCountChange} onNavigate={() => {}} />
    </ToastProvider>,
  );
  return { ...utils, fetchMock, onCountChange };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotificationDrawer — Watching tab (bug 8.8.1)', () => {
  it('renders the Watching tab ENABLED (the old disabled 5.4 seam is gone)', async () => {
    renderDrawer();
    const watching = await screen.findByRole('button', { name: /Watching/ });
    expect((watching as HTMLButtonElement).disabled).toBe(false);
    // The disabled-seam tooltip is gone.
    expect(watching.getAttribute('title')).toBeNull();
  });

  it('shows each tab its OWN category-scoped unread count, never the global total', async () => {
    renderDrawer(pageDTO());
    const direct = await screen.findByRole('button', { name: /Direct/ });
    const watching = screen.getByRole('button', { name: /Watching/ });
    // After the mount fetch reconciles: Direct shows 2, Watching shows 3.
    await waitFor(() => {
      expect(within(direct).getByText('2')).toBeTruthy();
      expect(within(watching).getByText('3')).toBeTruthy();
    });
    // The global total (5) is the bell's, never a tab badge.
    expect(screen.queryByText('5')).toBeNull();
  });

  it('switching to the Watching tab fetches that category', async () => {
    const { fetchMock } = renderDrawer();
    const watching = await screen.findByRole('button', { name: /Watching/ });
    fireEvent.click(watching);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('category=watching'))).toBe(
        true,
      );
    });
  });
});
