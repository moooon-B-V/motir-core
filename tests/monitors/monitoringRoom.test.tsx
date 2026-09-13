// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';

// THE MONITORING ROOM — `design/monitoring/monitoring-room.mock.html` panels 1,
// 1b, 2–4, 8 and 10 (Story MOTIR-4928 · MOTIR-5262). One test per state, plus
// the two mutations and the confirmation's two cases.
//
// The room renders straight from props, so "after a mutation" is asserted as the
// call to `router.refresh()` — the server read is what re-renders it.

const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const recheckMonitorHealthAction = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/ui/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Toast')>()),
  useToast: () => ({ toast }),
}));
vi.mock('@/app/(authed)/settings/project/monitoring/actions', () => ({
  recheckMonitorHealthAction,
}));

import { MonitoringRoom } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringRoom';
import { MonitoringLoading } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringStates';
import { MonitoringLoadError } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringLoadError';

function connection(slug: string): MonitorConnectionDto {
  return {
    id: `conn-${slug}`,
    provider: 'sentry',
    externalProjectId: `ext-${slug}`,
    externalProjectSlug: slug,
    health: 'connected',
    healthReason: null,
    healthCheckedAt: '2026-09-12T10:00:00.000Z',
    orgSlug: 'acme-inc',
    createdAt: '2026-09-09T10:00:00.000Z',
  };
}

function view(overrides: Partial<MonitorConnectionViewDto> = {}): MonitorConnectionViewDto {
  return {
    installationId: 'inst-1',
    orgSlug: 'acme-inc',
    health: 'connected',
    healthReason: null,
    healthCheckedAt: '2026-09-12T10:00:00.000Z',
    connections: [],
    ...overrides,
  };
}

function renderRoom(props: Partial<Parameters<typeof MonitoringRoom>[0]> = {}) {
  const v = props.view ?? view();
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonitoringRoom
        projectKey="ACME"
        view={v}
        banner={null}
        checkedLabel="checked 4 minutes ago"
        boundLabels={Object.fromEntries(v.connections.map((c) => [c.id, 'Bound 3 days ago']))}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  refresh.mockReset();
  toast.mockReset();
  recheckMonitorHealthAction.mockReset();
});

describe('panel 1 — no grant', () => {
  it('renders the empty state with Connect Sentry starting at Motir’s start route', () => {
    renderRoom({ view: view({ installationId: null, orgSlug: null, health: null }) });
    expect(screen.getByRole('heading', { name: 'No error monitor connected' })).toBeTruthy();
    const connect = screen.getByRole('link', { name: 'Connect Sentry' });
    const url = new URL(connect.getAttribute('href')!, 'https://motir.test');
    expect(url.pathname).toBe('/api/monitors/sentry/oauth/start');
    expect(url.searchParams.get('project')).toBe('ACME');
    // Nothing grant-shaped renders without a grant.
    expect(screen.queryByRole('button', { name: /Re-check/ })).toBeNull();
  });
});

describe('panel 1b — connected, nothing monitored', () => {
  it('names the organisation and offers Choose Sentry projects, which opens the picker', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([])));
    renderRoom();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('checked 4 minutes ago')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'No Sentry projects monitored yet' })).toBeTruthy();
    expect(screen.getByText(/Sentry is connected to acme-inc\./)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    // The room makes no provider read until the picker opens.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose Sentry projects' }));
    });
    expect(screen.getByRole('dialog', { name: 'Choose Sentry projects' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/ACME/monitors/available');
  });
});

describe('panels 2 and 3 — monitored projects', () => {
  it('renders one row with its slug, bound time and a disconnect action', () => {
    renderRoom({ view: view({ connections: [connection('acme-web')] }) });
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('acme-web')).toBeTruthy();
    expect(within(rows[0]!).getByText('Bound 3 days ago')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'Stop monitoring acme-web' })).toBeTruthy();
    expect(
      screen.getByText('Issues from these Sentry projects become bug work items on this board.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a monitored project' })).toBeTruthy();
  });

  it('renders several rows, with no Open-in-Sentry link and no issue count (§11)', () => {
    renderRoom({
      view: view({
        connections: [connection('acme-web'), connection('acme-worker'), connection('payments')],
      }),
    });
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/Open in Sentry/)).toBeNull();
    expect(screen.queryByText(/issues? seen/)).toBeNull();
  });
});

describe('panel 4 — degraded', () => {
  it('shows the filled Degraded chip, Sentry’s reason verbatim, and Reconnect', () => {
    renderRoom({
      view: view({
        health: 'degraded',
        healthReason: 'The authorization has been revoked.',
        connections: [connection('acme-web')],
      }),
    });
    expect(screen.getByText('Degraded')).toBeTruthy();
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Sentry says:');
    expect(banner.textContent).toContain('The authorization has been revoked.');
    expect(banner.textContent).toContain('nothing new will reach the board in the meantime');
    expect(screen.getByRole('link', { name: 'Reconnect' }).getAttribute('href')).toContain(
      '/api/monitors/sentry/oauth/start',
    );
    expect(
      screen.getByText('Nothing new arrives from these while the connection is degraded.'),
    ).toBeTruthy();
    // The rows stay visible: they are what is bound; the grant is what is broken.
    expect(screen.getByText('acme-web')).toBeTruthy();
  });

  it('a healthy grant offers no Reconnect', () => {
    renderRoom();
    expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
  });
});

describe('Re-check', () => {
  it('calls the page action, then refreshes the server read', async () => {
    recheckMonitorHealthAction.mockResolvedValue({ ok: true });
    renderRoom();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Re-check/ }));
    });
    expect(recheckMonitorHealthAction).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('says so when the probe could not run', async () => {
    recheckMonitorHealthAction.mockResolvedValue({ ok: false, code: 'failed' });
    renderRoom();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Re-check/ }));
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
  });
});

describe('panel 8 — disconnect, confirmed', () => {
  it('one of several: names the project, says which stay, and stops monitoring on confirm', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ removedGrant: false })));
    renderRoom({
      view: view({ connections: [connection('acme-web'), connection('acme-worker')] }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop monitoring acme-worker' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Stop monitoring acme-worker?')).toBeTruthy();
    expect(dialog.textContent).toContain('acme-web');
    expect(dialog.textContent).toContain('stays monitored');
    // Nothing is sent until the person confirms.
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Stop monitoring' }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/ACME/monitors/conn-acme-worker', {
      method: 'DELETE',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the last one: says it also removes the stored access to the organisation', () => {
    renderRoom({ view: view({ connections: [connection('acme-web')] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop monitoring acme-web' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Disconnect Sentry?')).toBeTruthy();
    expect(dialog.textContent).toContain("removes Motir's stored access to acme-inc");
    expect(within(dialog).getByRole('button', { name: 'Disconnect Sentry' })).toBeTruthy();
  });

  it('Cancel sends nothing', () => {
    renderRoom({ view: view({ connections: [connection('acme-web')] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop monitoring acme-web' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a refused disconnect keeps the dialog open and says nothing changed', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    renderRoom({ view: view({ connections: [connection('acme-web')] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop monitoring acme-web' }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect Sentry' }),
      );
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' }));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('panel 10 — the return banner', () => {
  it('renders above the grant and dismisses without touching the room', () => {
    renderRoom({
      banner: {
        tone: 'danger',
        title: "Couldn't connect Sentry.",
        body: 'Sentry says: The code has expired. Nothing was saved — try connecting again.',
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Sentry says: The code has expired.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Re-check/ })).toBeTruthy();
  });
});

describe('panel 9 — loading and error', () => {
  it('loading is the room’s own line', () => {
    render(<MonitoringLoading label="Loading monitoring…" />);
    expect(screen.getByText('Loading monitoring…')).toBeTruthy();
  });

  it('error says nothing changed, and Try again re-runs the server read', () => {
    render(
      <MonitoringLoadError
        title="Couldn't load monitoring for this project"
        body="Nothing has changed."
        retryLabel="Try again"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Nothing has changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
