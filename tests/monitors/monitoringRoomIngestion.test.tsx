// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
import type { PollLineView } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringRoom';

// THE MONITORING ROOM LEARNS INGESTION (Story MOTIR-4929 · Subtask MOTIR-5582)
// — `design/monitoring/monitoring-room--ingestion.mock.html` and
// `design-notes.md` §12: the minimum-level control on every row, and the poll
// line in every state of §12's table.
//
// The poll line arrives DECIDED (the server page runs `pollLineState` against
// the reconciler's own overdue constant — `tests/monitors/pollLine.test.ts`
// covers the decision and its threshold); what this file asserts is what each
// decided state RENDERS, and what the level control does with the write.

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

function renderRoom(v: MonitorConnectionViewDto, pollLines: Record<string, PollLineView> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonitoringRoom
        projectKey="ACME"
        view={v}
        banner={null}
        checkedLabel="checked 4 minutes ago"
        boundLabels={Object.fromEntries(v.connections.map((c) => [c.id, 'Bound 3 days ago']))}
        pollLines={pollLines}
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

describe('the minimum-level control', () => {
  it('shows the stored level on every row — `Every level` for null', () => {
    renderRoom(
      view({
        connections: [connection('web'), connection('worker', { minimumLevel: 'warning' })],
      }),
    );
    expect(
      within(row('web')).getByRole('combobox', { name: 'Minimum level' }).textContent,
    ).toContain('Every level');
    expect(
      within(row('worker')).getByRole('combobox', { name: 'Minimum level' }).textContent,
    ).toContain('warning');
  });

  it('lists Every level then the five levels, with the lowering helper in the open menu', async () => {
    renderRoom(view({ connections: [connection('web')] }));
    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual(['Every level', 'debug', 'info', 'warning', 'error', 'fatal']);
    expect(
      screen.getByText(
        'Choosing a lower level also checks earlier issues since this project was first monitored.',
      ),
    ).toBeTruthy();
  });

  it('PATCHes the chosen level, then shows the STORED value and refreshes the room', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderRoom(view({ connections: [connection('web')] }));

    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'error' }));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/ACME/monitors/conn-web', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minimumLevel: 'error' }),
    });
    // In flight: the control reads Saving… and neither it nor Disconnect is live.
    const trigger = within(row('web')).getByRole('combobox', { name: 'Minimum level' });
    expect(trigger.textContent).toContain('Saving…');
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(row('web')).getByRole('button', { name: 'Stop monitoring web' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      resolve(new Response(JSON.stringify(connection('web', { minimumLevel: 'error' }))));
    });

    // The stored value, without a manual reload — and the room's one refresh.
    expect(
      within(row('web')).getByRole('combobox', { name: 'Minimum level' }).textContent,
    ).toContain('error');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a REFUSED write reverts the control and says nothing changed, on the row', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'INVALID_MONITOR_LEVEL' }), { status: 400 }),
    );
    renderRoom(view({ connections: [connection('web', { minimumLevel: 'warning' })] }));

    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'fatal' }));
    });

    expect(
      within(row('web')).getByRole('combobox', { name: 'Minimum level' }).textContent,
    ).toContain('warning');
    const alert = within(row('web')).getByRole('alert');
    expect(alert.textContent).toBe("Couldn't change level. Nothing changed — try again.");
    expect(refresh).not.toHaveBeenCalled();
    // Local to the row: the grant is not turned degraded.
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('choosing the level already stored writes nothing', async () => {
    renderRoom(view({ connections: [connection('web', { minimumLevel: 'error' })] }));
    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'error' }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the poll line — one test per row of §12’s table', () => {
  function pollText(slug: string): string {
    return (row(slug).querySelector('[data-poll-state]')?.textContent ?? '').replace(/\s+/g, ' ');
  }

  it('never polled: Waiting for the first check (quiet)', () => {
    renderRoom(view({ connections: [connection('web')] }), { 'conn-web': { kind: 'waiting' } });
    expect(pollText('web')).toBe('Waiting for the first check');
    expect(row('web').querySelector('[data-poll-state="waiting"]')).not.toBeNull();
  });

  it('recent ok with NO bugs filed: the check, and no count', () => {
    renderRoom(view({ connections: [connection('web')] }), {
      'conn-web': { kind: 'ok', ago: '4 minutes ago', filedCount: 0 },
    });
    expect(pollText('web')).toBe('Checked for new errors 4 minutes ago');
  });

  it('recent ok WITH bugs filed: the count, strong, in the same quiet line', () => {
    renderRoom(view({ connections: [connection('web')] }), {
      'conn-web': { kind: 'ok', ago: '9 minutes ago', filedCount: 3 },
    });
    expect(pollText('web')).toBe('Checked for new errors 9 minutes ago · 3 bugs filed');
    expect(within(row('web')).getByText('3 bugs filed').tagName).toBe('B');
  });

  it('overdue: No check since <time>, as a warning line', () => {
    renderRoom(view({ connections: [connection('web')] }), {
      'conn-web': { kind: 'overdue', since: 'Sep 18, 2026, 9:30 AM' },
    });
    expect(pollText('web')).toBe(
      'No check since Sep 18, 2026, 9:30 AM. Two scheduled checks were missed.',
    );
    expect(row('web').querySelector('[data-poll-state="overdue"]')).not.toBeNull();
  });

  it('failed: the stored reason VERBATIM, and when it last succeeded', () => {
    const reason = 'Sentry returned 429: {rate limited} <try later>';
    renderRoom(view({ connections: [connection('web')] }), {
      'conn-web': { kind: 'failed', reason, lastSuccess: 'Sep 17, 2026, 4:42 PM' },
    });
    expect(pollText('web')).toBe(
      `Couldn't check for new errors: ${reason} Last successful check Sep 17, 2026, 4:42 PM.`,
    );
  });

  it('failed with NO successful check ever: the second sentence is omitted', () => {
    renderRoom(view({ connections: [connection('web')] }), {
      'conn-web': {
        kind: 'failed',
        reason: 'The authorization has been revoked.',
        lastSuccess: null,
      },
    });
    expect(pollText('web')).toBe(
      "Couldn't check for new errors: The authorization has been revoked.",
    );
  });

  it('a DEGRADED grant: the banner stays loudest, and every row reads failed beneath it', () => {
    renderRoom(
      view({
        health: 'degraded',
        healthReason: 'The authorization has been revoked.',
        connections: [connection('web'), connection('worker')],
      }),
      {
        'conn-web': {
          kind: 'failed',
          reason: 'Sentry refused this connection.',
          lastSuccess: null,
        },
        'conn-worker': {
          kind: 'failed',
          reason: 'Sentry refused this connection.',
          lastSuccess: null,
        },
      },
    );
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('The authorization has been revoked.');
    for (const slug of ['web', 'worker']) {
      expect(row(slug).querySelector('[data-poll-state="failed"]')).not.toBeNull();
    }
  });
});

describe('the room’s remaining arms (the story gate’s top-up, MOTIR-5583)', () => {
  it('choosing Every level PATCHes null — the stored default', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(connection('web'))));
    renderRoom(view({ connections: [connection('web', { minimumLevel: 'warning' })] }));
    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Every level' }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/ACME/monitors/conn-web',
      expect.objectContaining({ body: JSON.stringify({ minimumLevel: null }) }),
    );
  });

  it('a network failure on the write is a refusal too — reverted, said on the row', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderRoom(view({ connections: [connection('web', { minimumLevel: 'error' })] }));
    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('combobox', { name: 'Minimum level' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'debug' }));
    });
    expect(within(row('web')).getByRole('alert')).toBeTruthy();
    expect(
      within(row('web')).getByRole('combobox', { name: 'Minimum level' }).textContent,
    ).toContain('error');
  });

  it('a degraded grant with no provider reason and no check time still renders', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <MonitoringRoom
          projectKey="ACME"
          view={view({ health: 'degraded', healthReason: null, connections: [connection('web')] })}
          banner={{ tone: 'danger', title: 'Could not connect.', body: 'Sentry refused.' }}
          checkedLabel={null}
          boundLabels={{ 'conn-web': 'Bound 3 days ago' }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Could not connect.');
    // No poll line was decided for the row, so none renders.
    expect(row('web').querySelector('[data-poll-state]')).toBeNull();
  });

  it('Add a monitored project opens the picker, and the disconnect confirmation dismisses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([])));
    renderRoom(view({ connections: [connection('web')] }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a monitored project' }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/ACME/monitors/available');
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });

    await act(async () => {
      fireEvent.click(within(row('web')).getByRole('button', { name: 'Stop monitoring web' }));
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
