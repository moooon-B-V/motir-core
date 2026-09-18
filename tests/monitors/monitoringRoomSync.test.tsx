// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
import type { PollLineView } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringRoom';

// THE MONITORING ROOM LEARNS SYNC (Story MOTIR-4931 · Subtask MOTIR-5707) —
// `design/monitoring/monitoring-room--sync.mock.html` and `design-notes.md` §13:
// the two per-connection direction switches in the row's SYNC band, their
// write-on-toggle with pending and refused states, operability on a degraded
// grant, and the last failed resolve-back directly under its switch.

const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/ui/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Toast')>()),
  useToast: () => ({ toast }),
}));
vi.mock('@/app/(authed)/settings/project/monitoring/actions', () => ({
  recheckMonitorHealthAction: vi.fn(),
}));

import { MonitoringRoom } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringRoom';

function connection(
  slug: string,
  overrides: Partial<MonitorConnectionDto> = {},
): MonitorConnectionDto {
  return {
    id: `conn-${slug}`,
    provider: 'sentry',
    externalProjectId: `ext-${slug}`,
    externalProjectSlug: slug,
    health: 'connected',
    healthReason: null,
    healthCheckedAt: '2026-09-18T10:00:00.000Z',
    orgSlug: 'acme-inc',
    createdAt: '2026-09-15T10:00:00.000Z',
    minimumLevel: null,
    lastPolledAt: null,
    lastPollStatus: null,
    lastPollError: null,
    lastPollFiledCount: null,
    lastPollSucceededAt: null,
    resolveOnDone: true,
    syncAssignee: true,
    lastSyncError: null,
    lastSyncErrorAt: null,
    lastSyncErrorWorkItemIdentifier: null,
    ...overrides,
  };
}

function view(overrides: Partial<MonitorConnectionViewDto> = {}): MonitorConnectionViewDto {
  return {
    installationId: 'inst-1',
    orgSlug: 'acme-inc',
    health: 'connected',
    healthReason: null,
    healthCheckedAt: '2026-09-18T10:00:00.000Z',
    connections: [],
    ...overrides,
  };
}

function renderRoom(
  v: MonitorConnectionViewDto,
  pollLines: Record<string, PollLineView> = {},
  syncErrorLabels: Record<string, string> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonitoringRoom
        projectKey="ACME"
        view={v}
        banner={null}
        checkedLabel="checked 4 minutes ago"
        boundLabels={Object.fromEntries(v.connections.map((c) => [c.id, 'Bound 3 days ago']))}
        pollLines={pollLines}
        syncErrorLabels={syncErrorLabels}
      />
    </NextIntlClientProvider>,
  );
}

const row = (slug: string) =>
  screen.getAllByRole('listitem').find((li) => within(li).queryByText(slug))!;

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
});

const RESOLVE = 'Resolve in Sentry when the bug is done';
const ASSIGNEE = 'Take the assignee from Sentry';
const sw = (slug: string, name: string) => within(row(slug)).getByRole('switch', { name });

function dto(overrides: Partial<MonitorConnectionDto>): Response {
  return new Response(JSON.stringify(connection('web', overrides)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the SYNC band — two switches, labelled by outcome, each with its hint', () => {
  it('renders both switches ON for a freshly bound connection, with the band label and hints', () => {
    renderRoom(view({ connections: [connection('web')] }));
    const band = within(row('web')).getByTestId('monitor-sync-band');
    expect(within(band).getByText('Sync with Sentry')).toBeTruthy();
    expect(sw('web', RESOLVE).getAttribute('aria-checked')).toBe('true');
    expect(sw('web', ASSIGNEE).getAttribute('aria-checked')).toBe('true');
    expect(
      within(band).getByText(
        'Turn off to leave Sentry issues as they are when their bugs are done.',
      ),
    ).toBeTruthy();
    expect(within(band).getByText('Turn off to ignore assignments made in Sentry.')).toBeTruthy();
  });

  it('reflects each stored value independently', () => {
    renderRoom(
      view({
        connections: [
          connection('web', { resolveOnDone: false }),
          connection('worker', { syncAssignee: false }),
        ],
      }),
    );
    expect(sw('web', RESOLVE).getAttribute('aria-checked')).toBe('false');
    expect(sw('web', ASSIGNEE).getAttribute('aria-checked')).toBe('true');
    expect(sw('worker', RESOLVE).getAttribute('aria-checked')).toBe('true');
    expect(sw('worker', ASSIGNEE).getAttribute('aria-checked')).toBe('false');
  });
});

describe('write on toggle', () => {
  it('PATCHes ONLY the key that changed, shows Saving… while in flight, then renders the answer', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderRoom(view({ connections: [connection('web')] }));

    await act(async () => {
      fireEvent.click(sw('web', RESOLVE));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/ACME/monitors/conn-web');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ resolveOnDone: false });
    // Moved at once, disabled, Saving… after its label; Disconnect disabled; the
    // OTHER switch stays operable.
    expect(sw('web', RESOLVE).getAttribute('aria-checked')).toBe('false');
    expect((sw('web', RESOLVE) as HTMLButtonElement).disabled).toBe(true);
    expect(within(row('web')).getByText('Saving…')).toBeTruthy();
    expect(
      (within(row('web')).getByRole('button', { name: 'Stop monitoring web' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((sw('web', ASSIGNEE) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolve(dto({ resolveOnDone: false }));
    });

    expect(sw('web', RESOLVE).getAttribute('aria-checked')).toBe('false');
    expect((sw('web', RESOLVE) as HTMLButtonElement).disabled).toBe(false);
    expect(within(row('web')).queryByText('Saving…')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a REFUSED write returns the switch to the stored value and shows the failed-save line', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    renderRoom(view({ connections: [connection('web')] }));

    await act(async () => {
      fireEvent.click(sw('web', ASSIGNEE));
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ syncAssignee: false });
    expect(sw('web', ASSIGNEE).getAttribute('aria-checked')).toBe('true');
    const alert = within(row('web')).getByRole('alert');
    expect(alert.textContent).toContain("Couldn't change this setting.");
    expect(alert.textContent).toContain('Nothing changed — try again.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a network failure is a refusal too', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    renderRoom(view({ connections: [connection('web')] }));
    await act(async () => {
      fireEvent.click(sw('web', RESOLVE));
    });
    expect(sw('web', RESOLVE).getAttribute('aria-checked')).toBe('true');
    expect(within(row('web')).getByRole('alert').textContent).toContain(
      "Couldn't change this setting.",
    );
  });

  it('both switches stay OPERABLE on a degraded grant', async () => {
    fetchMock.mockResolvedValue(dto({ syncAssignee: false }));
    renderRoom(
      view({
        health: 'degraded',
        healthReason: 'The authorization has been revoked.',
        connections: [connection('web', { health: 'degraded' })],
      }),
    );
    expect((sw('web', RESOLVE) as HTMLButtonElement).disabled).toBe(false);
    expect((sw('web', ASSIGNEE) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sw('web', ASSIGNEE));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sw('web', ASSIGNEE).getAttribute('aria-checked')).toBe('false');
  });
});

describe('the failed resolve-back line', () => {
  it('renders the provider’s reason verbatim, a link to the bug and a relative time', () => {
    renderRoom(
      view({
        connections: [
          connection('web', {
            lastSyncError: 'You do not have permission to perform this action.',
            lastSyncErrorAt: '2026-09-18T10:00:00.000Z',
            lastSyncErrorWorkItemIdentifier: 'ACME-812',
          }),
        ],
      }),
      {},
      { 'conn-web': '12 minutes ago' },
    );
    const line = within(row('web')).getByTestId('monitor-sync-failure');
    expect(line.textContent).toContain("Couldn't resolve Sentry's issue for ACME-812:");
    expect(line.textContent).toContain('You do not have permission to perform this action.');
    expect(line.textContent).toContain('Tried 12 minutes ago.');
    expect(within(line).getByRole('link', { name: 'ACME-812' }).getAttribute('href')).toBe(
      '/items/ACME-812',
    );
    // Under the RESOLVE switch it belongs to — inside that switch's item.
    const resolveItem = sw('web', RESOLVE).parentElement!;
    expect(resolveItem.contains(line)).toBe(true);
  });

  it('renders nothing when no failure is recorded — never resolved, or last resolve succeeded', () => {
    renderRoom(view({ connections: [connection('web')] }));
    expect(within(row('web')).queryByTestId('monitor-sync-failure')).toBeNull();
  });
});
