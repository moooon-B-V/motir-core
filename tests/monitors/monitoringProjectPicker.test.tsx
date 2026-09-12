// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { AvailableMonitorProjectDto } from '@/lib/dto/monitors';
import { MonitoringProjectPicker } from '@/app/(authed)/settings/project/monitoring/_components/MonitoringProjectPicker';

// THE PROJECT PICKER — design/monitoring panels 6 and 7 and §11's rules
// (Story MOTIR-4928 · MOTIR-5297).

const PROJECTS: AvailableMonitorProjectDto[] = [
  { externalId: 'p-web', slug: 'acme-web', name: 'Web', bound: true },
  { externalId: 'p-worker', slug: 'acme-worker', name: 'Worker', bound: false },
  { externalId: 'p-pay', slug: 'acme-payments', name: 'Payments', bound: false },
  { externalId: 'p-mobile', slug: 'acme-mobile', name: 'Mobile', bound: false },
  { externalId: 'p-mkt', slug: 'marketing-site', name: 'Marketing site', bound: false },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn();
const onBound = vi.fn();
const onOpenChange = vi.fn();

/** Route the mock by method + URL, and record the POSTed project ids. */
function serve({
  available,
  bind = () => json({}, 201),
}: {
  available: () => Response;
  bind?: (externalProjectId: string) => Response;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/monitors/available')) return available();
    if (url.endsWith('/monitors') && init?.method === 'POST') {
      return bind(JSON.parse(String(init.body)).externalProjectId);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const posted = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).externalProjectId as string);

async function openPicker() {
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <MonitoringProjectPicker
          open
          onOpenChange={onOpenChange}
          projectKey="ACME"
          org="acme-inc"
          connectHref="/api/monitors/sentry/oauth/start?project=ACME"
          onBound={onBound}
        />
      </NextIntlClientProvider>,
    );
  });
  return screen.getByRole('dialog');
}

const box = (dialog: HTMLElement, slug: string) =>
  within(dialog).getByRole('checkbox', { name: new RegExp(`^${slug},`) });

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  onBound.mockReset();
  onOpenChange.mockReset();
});

describe('opening', () => {
  it('issues exactly one available-projects read', async () => {
    serve({ available: () => json(PROJECTS) });
    await openPicker();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/ACME/monitors/available');
  });

  it('names the organisation the list is from', async () => {
    serve({ available: () => json(PROJECTS) });
    const dialog = await openPicker();
    expect(dialog.textContent).toContain('From acme-inc.');
  });
});

describe('rows', () => {
  it('shows an already-bound project checked, locked and labelled — never hidden', async () => {
    serve({ available: () => json(PROJECTS) });
    const dialog = await openPicker();
    const web = box(dialog, 'acme-web');
    expect(web.getAttribute('aria-checked')).toBe('true');
    expect((web as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Already monitored')).toBeTruthy();
  });

  it('filters by slug and by name, case-insensitively, without refetching', async () => {
    serve({ available: () => json(PROJECTS) });
    const dialog = await openPicker();
    const filter = within(dialog).getByRole('textbox', { name: 'Filter projects' });
    fireEvent.change(filter, { target: { value: 'PAY' } });
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['acme-payments, Not chosen']);
    fireEvent.change(filter, { target: { value: 'marketing site' } });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).getByText('marketing-site')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the primary action', () => {
  it('counts NEW ticks only, and is disabled at zero', async () => {
    serve({ available: () => json(PROJECTS) });
    const dialog = await openPicker();
    const primary = () =>
      within(dialog).getByRole('button', { name: /^Monitor/ }) as HTMLButtonElement;
    expect(primary().disabled).toBe(true);
    fireEvent.click(box(dialog, 'acme-worker'));
    expect(primary().textContent).toBe('Monitor 1 project');
    fireEvent.click(box(dialog, 'acme-payments'));
    expect(primary().textContent).toBe('Monitor 2 projects');
    expect(primary().disabled).toBe(false);
  });

  it('binds every new tick, closes and refreshes the room when all succeed', async () => {
    serve({ available: () => json(PROJECTS) });
    const dialog = await openPicker();
    fireEvent.click(box(dialog, 'acme-worker'));
    fireEvent.click(box(dialog, 'acme-payments'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Monitor 2 projects' }));
    });
    expect(posted().sort()).toEqual(['p-pay', 'p-worker']);
    // The slug travels with the id — the bind route requires both.
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(body).toHaveProperty('externalProjectSlug');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onBound).toHaveBeenCalledTimes(1);
  });
});

describe('the partial result (§11)', () => {
  it('201 + already-bound 409 lock as Now monitored; a 502 stays ticked and Try again re-POSTs only it', async () => {
    let payAttempts = 0;
    serve({
      available: () => json(PROJECTS),
      bind: (id) => {
        if (id === 'p-worker') return json({}, 201);
        if (id === 'p-mobile') return json({ code: 'MONITOR_CONNECTION_ALREADY_EXISTS' }, 409);
        payAttempts += 1;
        return payAttempts === 1
          ? json({ code: 'MONITOR_PROVIDER_CALL_FAILED', providerReason: 'x' }, 502)
          : json({}, 201);
      },
    });
    const dialog = await openPicker();
    for (const slug of ['acme-worker', 'acme-mobile', 'acme-payments']) {
      fireEvent.click(box(dialog, slug));
    }
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Monitor 3 projects' }));
    });

    expect(dialog.textContent).toContain(
      '2 of 3 projects added. The other one wasn’t.'.replace('’', "'"),
    );
    expect(within(dialog).getAllByText('Now monitored')).toHaveLength(2);
    const pay = box(dialog, 'acme-payments');
    expect(pay.getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByText("Couldn't add — try again")).toBeTruthy();
    // The partial view narrows to what was decided: no un-ticked rows, no filter.
    expect(within(dialog).queryByText('marketing-site')).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(onBound).not.toHaveBeenCalled();

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    });
    expect(posted()).toEqual(['p-pay']);
    expect(onBound).toHaveBeenCalledTimes(1);
  });

  it('a failed row stays ticked but can be unticked, and Try again then has nothing to send', async () => {
    serve({ available: () => json(PROJECTS), bind: () => json({}, 500) });
    const dialog = await openPicker();
    fireEvent.click(box(dialog, 'acme-worker'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Monitor 1 project' }));
    });
    const worker = box(dialog, 'acme-worker') as HTMLButtonElement;
    expect(worker.getAttribute('aria-checked')).toBe('true');
    expect(worker.disabled).toBe(false);
    fireEvent.click(worker);
    expect(
      (within(dialog).getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('Done closes with the successes kept, and refreshes the room', async () => {
    serve({
      available: () => json(PROJECTS),
      bind: (id) => (id === 'p-worker' ? json({}, 201) : json({}, 500)),
    });
    const dialog = await openPicker();
    fireEvent.click(box(dialog, 'acme-worker'));
    fireEvent.click(box(dialog, 'acme-payments'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Monitor 2 projects' }));
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onBound).toHaveBeenCalledTimes(1);
  });

  it('a 409 for a MISSING GRANT is a failure, not a success', async () => {
    serve({
      available: () => json(PROJECTS),
      bind: () => json({ code: 'MONITOR_GRANT_NOT_FOUND' }, 409),
    });
    const dialog = await openPicker();
    fireEvent.click(box(dialog, 'acme-worker'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Monitor 1 project' }));
    });
    expect(within(dialog).queryByText('Now monitored')).toBeNull();
    expect(within(dialog).getByText("Couldn't add — try again")).toBeTruthy();
    expect(onBound).not.toHaveBeenCalled();
  });
});

describe('panel 7 — the picker on a degraded grant', () => {
  it('renders Sentry’s reason verbatim and Reconnect, and no project list', async () => {
    serve({
      available: () =>
        json(
          {
            code: 'MONITOR_PROVIDER_CALL_FAILED',
            providerReason: 'The authorization has been revoked.',
          },
          502,
        ),
    });
    const dialog = await openPicker();
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load acme-inc's projects.");
    expect(alert.textContent).toContain('Sentry says: The authorization has been revoked.');
    expect(within(dialog).getByRole('link', { name: 'Reconnect' }).getAttribute('href')).toContain(
      '/api/monitors/sentry/oauth/start',
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });
});
