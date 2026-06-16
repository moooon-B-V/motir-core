// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ArchivedBanner } from '@/app/(authed)/issues/[key]/_components/ArchivedBanner';

// The archived banner on the work-item detail page (Story 2.9 · Subtask 2.9.6)
// under happy-dom — the banner's archived-vs-active render is decided by the
// PAGE (it only mounts this when `item.archivedAt != null`), so these tests
// cover the banner itself: its copy + the `canEdit` gating, and the
// page-state-after-mutation contract on Restore (refresh + toast only AFTER the
// authoritative unarchive 200, never on the optimistic click alone).

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(() => {
  refresh.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

describe('ArchivedBanner', () => {
  it('renders the archived headline + who/when, and the Restore action (canEdit)', () => {
    render(
      <ArchivedBanner
        itemId="wi_49"
        identifier="PROD-49"
        archivedByName="Dana Kim"
        archivedAtLabel="Jun 15, 2026"
        canEdit
      />,
    );

    const banner = screen.getByTestId('archived-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByText('This work item is archived')).toBeTruthy();
    // The meta line names the actor + date and (canEdit) carries the restore tail.
    expect(screen.getByText('Dana Kim')).toBeTruthy();
    expect(screen.getByText(/Jun 15, 2026/)).toBeTruthy();
    expect(screen.getByText(/Restore it to bring it back\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore PROD-49' })).toBeTruthy();
  });

  it('falls back to a generic actor when the archiver is unresolved', () => {
    render(
      <ArchivedBanner
        itemId="wi_49"
        identifier="PROD-49"
        archivedByName={null}
        archivedAtLabel="Jun 15, 2026"
        canEdit
      />,
    );
    expect(screen.getByText('a former member')).toBeTruthy();
  });

  it('Restore: refresh + success toast fire only AFTER the unarchive 200 (page-state)', async () => {
    let resolveFetch: (v: { ok: boolean }) => void = () => {};
    const fetchMock = vi.fn(
      (..._args: unknown[]) =>
        new Promise((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ArchivedBanner
        itemId="wi_49"
        identifier="PROD-49"
        archivedByName="Dana Kim"
        archivedAtLabel="Jun 15, 2026"
        canEdit
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore PROD-49' }));

    // Optimistic-only: the DELETE is in flight, the button is busy, but the page
    // is NOT refreshed yet (no premature read of pre-write state).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain('/api/work-items/wi_49/archive');
    expect(call?.[1]).toMatchObject({ method: 'DELETE' });
    expect(screen.getByRole('button', { name: 'Restore PROD-49' }).getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(refresh).not.toHaveBeenCalled();

    // The authoritative 200 — NOW the page refreshes (clears the banner) + toast.
    resolveFetch({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText('PROD-49 restored')).toBeTruthy();
  });

  it('a failed restore keeps the banner (no refresh) and surfaces an error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ code: 'BOOM' }) })),
    );

    render(
      <ArchivedBanner
        itemId="wi_49"
        identifier="PROD-49"
        archivedByName="Dana Kim"
        archivedAtLabel="Jun 15, 2026"
        canEdit
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore PROD-49' }));

    await waitFor(() => expect(screen.getByText('Couldn’t restore')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
    // The banner stays so the viewer can retry, and the button leaves its busy state.
    expect(screen.getByTestId('archived-banner')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Restore PROD-49' }).getAttribute('aria-busy'),
      ).not.toBe('true'),
    );
  });

  it('view-only (not canEdit): the banner renders without Restore or the restore tail', () => {
    render(
      <ArchivedBanner
        itemId="wi_49"
        identifier="PROD-49"
        archivedByName="Dana Kim"
        archivedAtLabel="Jun 15, 2026"
        canEdit={false}
      />,
    );
    expect(screen.getByText('This work item is archived')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(screen.queryByText(/Restore it to bring it back\./)).toBeNull();
  });
});
