// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  ConnectedAppsSection,
  ConnectedAppsSkeleton,
  relativeOrDate,
} from '@/app/(authed)/settings/account/_components/ConnectedAppsSection';
import type { OAuthConnectionDto } from '@/lib/dto/oauthConnections';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { ToastProvider } from '@/components/ui/Toast';

// Settings → Account → CONNECTED APPS, the client island (Story MOTIR-6973 ·
// Subtask MOTIR-6986), built to `design/settings/account-settings--connected-apps.mock.html`.
// One test per state the delta draws — populated, disclosed scopes, empty,
// loading, error and its retry, the revoke confirm, revoking, revoked (and a
// failed revoke) — plus the 404-is-success rule. The routes are
// `tests/oauth/connectedAppsRoutes.test.ts`.

function connection(over: Partial<OAuthConnectionDto> = {}): OAuthConnectionDto {
  return {
    id: 'c1',
    client: {
      clientId: 'cl-1',
      name: 'Claude',
      uri: null,
      icon: null,
      unverified: true,
      host: 'claude.ai',
      discoveredHost: null,
    },
    workspace: { id: 'w1', name: 'Motir' },
    organization: { id: 'o1', name: 'moooon' },
    project: null,
    permissions: [...DEFAULT_TOKEN_GRANT],
    createdAt: '2026-09-01T10:00:00.000Z',
    lastUsedAt: null,
    ...over,
  };
}

const TWO = [
  connection(),
  connection({
    id: 'c2',
    client: {
      clientId: 'cl-2',
      name: 'Claude Code',
      uri: null,
      icon: null,
      unverified: false,
      host: 'localhost',
      discoveredHost: null,
    },
    workspace: { id: 'w2', name: 'Client work' },
    project: { id: 'p1', name: 'Website' },
    permissions: [...GRANTABLE_PERMISSIONS],
  }),
];

function stubFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body?: unknown },
) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      const { status, body } = handler(String(url), init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }),
  );
  return calls;
}

function render(initial: OAuthConnectionDto[] | null, multiOrg = false) {
  return renderWithIntl(
    <ToastProvider>
      <ConnectedAppsSection initialConnections={initial} multiOrg={multiOrg} />
    </ToastProvider>,
  );
}

/** The wide table (the narrow list renders beside it; CSS picks one). */
function table() {
  return within(screen.getByRole('table'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConnectedAppsSection', () => {
  it('populated: one row per grant with the app, Unverified, host, scopes, workspace and dates', () => {
    render(TWO);
    const rows = screen.getAllByTestId('connected-app-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText('Claude')).toBeTruthy();
    expect(first.getByText('Unverified')).toBeTruthy();
    expect(first.getByText('claude.ai')).toBeTruthy();
    expect(first.getByText('Motir')).toBeTruthy();
    expect(first.getByText('All projects')).toBeTruthy();
    expect(first.getByText('Never')).toBeTruthy();
    expect(first.queryByText('Can delete')).toBeNull();

    const second = within(rows[1]!);
    // A client Motir registered carries no pill at all — there is no "Verified".
    expect(second.queryByText('Unverified')).toBeNull();
    expect(second.getByText('localhost')).toBeTruthy();
    expect(second.getByText('Website')).toBeTruthy();
    expect(second.getByText('Full access')).toBeTruthy();
    expect(second.getByText('Can delete')).toBeTruthy();

    // The card is the anchor the consent screen and the docs link to.
    expect(document.getElementById('connected-apps')).toBeTruthy();
  });

  it('prefixes the organisation only when the reader belongs to more than one', () => {
    render([connection()], true);
    expect(table().getByText('moooon · Motir')).toBeTruthy();
  });

  it('discloses the grant in the picker columns: granted and not-granted both named', () => {
    render([connection()]);
    fireEvent.click(table().getByRole('button', { name: 'Show scopes for Claude' }));
    expect(table().getByText('This app can:')).toBeTruthy();
    const items = document.querySelectorAll('table li[data-permission]');
    expect(items).toHaveLength(GRANTABLE_PERMISSIONS.length);
    const del = document.querySelector('table li[data-permission="work_item:delete"]')!;
    expect(del.getAttribute('data-granted')).toBe('false');
    expect(del.textContent).toContain('Not granted');
    const granted = document.querySelector(
      `table li[data-permission="${DEFAULT_TOKEN_GRANT[0]}"]`,
    )!;
    expect(granted.getAttribute('data-granted')).toBe('true');
    expect(granted.textContent).toContain('Granted');
    expect(table().getByRole('button', { name: 'Hide scopes for Claude' })).toBeTruthy();
  });

  it('empty: one line and the link to add Motir to Claude', () => {
    render([]);
    expect(screen.getByText(/No apps connected/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'How to add Motir to Claude' });
    expect(link.getAttribute('href')).toBe('https://motir.co/docs/mcp');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('loading: the header over three skeleton rows, announced once', () => {
    renderWithIntl(<ConnectedAppsSkeleton />);
    expect(screen.getByText('Connected apps')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Loading…');
  });

  it('error: an inline alert, and Try again re-reads the list', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { connections: [connection()] } }));
    render(null);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Couldn’t load your connected apps.'.replace('’', "'"));
    expect(alert.textContent).toContain('Nothing was revoked.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByTestId('connected-app-row')).toHaveLength(1));
    expect(calls[0]).toEqual({ url: '/api/account/oauth-connections', method: 'GET' });
  });

  it('revoke confirm names the app, the workspace and the grant', () => {
    render([connection()]);
    fireEvent.click(table().getByRole('button', { name: 'Revoke Claude in Motir' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Revoke “Claude”?')).toBeTruthy();
    expect(dialog.textContent).toContain('loses access to the Motir workspace now');
    expect(dialog.textContent).toContain('Motir · All projects');
    expect(dialog.textContent).toContain('Standard');
  });

  it('revoking locks the dialog; revoked splices the row out and toasts', async () => {
    let release: () => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve({ ok: true, status: 204 } as Response);
          }),
      ),
    );
    render(TWO);
    fireEvent.click(table().getByRole('button', { name: 'Revoke Claude in Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));

    // Revoking: Cancel disabled, the close button withdrawn, Escape ignored.
    const dialog = screen.getByRole('dialog');
    expect(
      (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    expect(screen.getAllByTestId('connected-app-row')).toHaveLength(1);
    expect(screen.getByText('Access revoked')).toBeTruthy();
    // The toast renders it, and Radix's live region may announce it a second time.
    expect(screen.getAllByText(/Claude can no longer act in Motir/).length).toBeGreaterThan(0);
  });

  it('a 404 (already gone) counts as revoked; the last row leaves the empty state', async () => {
    stubFetch(() => ({ status: 404, body: { code: 'OAUTH_CONNECTION_NOT_FOUND' } }));
    render([connection()]);
    fireEvent.click(table().getByRole('button', { name: 'Revoke Claude in Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    expect(screen.getByText(/No apps connected/)).toBeTruthy();
  });

  it('a failed revoke keeps the dialog and the row, and says so', async () => {
    stubFetch(() => ({ status: 500 }));
    render([connection()]);
    fireEvent.click(table().getByRole('button', { name: 'Revoke Claude in Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await screen.findByText('Couldn’t revoke access'.replace('’', "'"));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByTestId('connected-app-row')).toHaveLength(1);
  });
});

describe('relativeOrDate', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  it('is relative inside seven days and absolute beyond', () => {
    expect(relativeOrDate('2026-09-30T11:58:00.000Z', now, 'en')).toBe('2 minutes ago');
    expect(relativeOrDate('2026-09-29T12:00:00.000Z', now, 'en')).toBe('yesterday');
    expect(relativeOrDate('2026-09-01T12:00:00.000Z', now, 'en')).not.toMatch(/ago/);
  });
});

describe('ConnectedAppsSection — the edges', () => {
  it('an app with no name or host reads as unnamed; a granted delete gets the rose row', () => {
    render([
      connection({
        client: {
          clientId: 'x',
          name: null,
          uri: null,
          icon: null,
          unverified: true,
          host: null,
          discoveredHost: null,
        },
        permissions: [...GRANTABLE_PERMISSIONS],
      }),
    ]);
    expect(table().getByText('Unnamed app')).toBeTruthy();
    fireEvent.click(table().getByRole('button', { name: 'Show scopes for Unnamed app' }));
    const del = document.querySelector('table li[data-permission="work_item:delete"]')!;
    expect(del.getAttribute('data-granted')).toBe('true');
    expect(del.className).toContain('--el-tint-rose');
  });

  it('Last used is relative once mounted, absolute past a week, with the exact time on hover', () => {
    const recent = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    render([
      connection({ lastUsedAt: recent }),
      connection({ id: 'c3', lastUsedAt: '2020-01-02T10:00:00.000Z' }),
    ]);
    const rows = screen.getAllByTestId('connected-app-row');
    expect(within(rows[0]!).getByText('2 minutes ago').getAttribute('title')).toBeTruthy();
    expect(rows[1]!.textContent).not.toMatch(/ago/);
  });

  it('the narrow list discloses and revokes the same connection', async () => {
    stubFetch(() => ({ status: 204 }));
    render([connection()]);
    const list = within(screen.getByTestId('connected-apps-narrow'));
    fireEvent.click(list.getByRole('button', { name: 'Show scopes for Claude' }));
    expect(list.getByText('This app can:')).toBeTruthy();
    fireEvent.click(list.getByRole('button', { name: 'Revoke Claude in Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    expect(screen.getByText(/No apps connected/)).toBeTruthy();
  });

  it('Cancel closes the confirm and revokes nothing', () => {
    const calls = stubFetch(() => ({ status: 204 }));
    render([connection()]);
    fireEvent.click(table().getByRole('button', { name: 'Revoke Claude in Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(screen.getAllByTestId('connected-app-row')).toHaveLength(1);
  });

  it('a Try again that fails again stays on the error line', async () => {
    const calls = stubFetch(() => ({ status: 500 }));
    render(null);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('relativeOrDate — every unit', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  it('seconds, hours and days', () => {
    expect(relativeOrDate('2026-09-30T11:59:30.000Z', now, 'en')).toBe('now');
    expect(relativeOrDate('2026-09-30T09:00:00.000Z', now, 'en')).toBe('3 hours ago');
    expect(relativeOrDate('2026-09-27T12:00:00.000Z', now, 'en')).toBe('3 days ago');
  });
});
