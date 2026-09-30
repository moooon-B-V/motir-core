// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ConsentScreen } from '@/app/(auth)/oauth/_components/ConsentScreen';
import type { ConsentRequestDto } from '@/lib/dto/oauthConnections';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';

// The consent screen's client island (Story MOTIR-6973 · Subtask MOTIR-6985),
// built to `design/auth/oauth-consent.mock.html`. The server half (the request
// read, approve, deny) is `tests/oauth/consentScreen.test.tsx`; this pins the
// island's states and what each press SENDS — the reach choice, the narrowed
// grant, the empty-grant gate, and where a refusal lands.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const REQUEST: ConsentRequestDto = {
  client: { clientId: 'c1', name: 'Claude Code', unverified: true },
  redirectUri: 'http://127.0.0.1:53682/callback',
  redirectHost: '127.0.0.1:53682',
  loopback: true,
  workspaces: [
    {
      id: 'ws-1',
      label: 'moooon · Motir',
      projects: [
        {
          id: 'p-1',
          key: 'MOTIR',
          name: 'Motir',
          grantable: [...GRANTABLE_PERMISSIONS].filter((k) => k !== 'plan:view_any'),
        },
      ],
    },
  ],
  unusableWorkspaces: [],
};

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }),
  );
  return calls;
}

function renderScreen(request: ConsentRequestDto = REQUEST) {
  const navigate = vi.fn();
  renderWithIntl(
    <ConsentScreen
      oauthQuery="client_id=c1&sig=x"
      request={request}
      user={{ name: 'Zhu Yue', email: 'zhuyue11@gmail.com' }}
      activeWorkspaceId={null}
      activeProjectId={null}
      signInHref="/sign-in"
      navigate={navigate}
    />,
  );
  return navigate;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

describe('ConsentScreen', () => {
  it('names the app as unverified, where it returns to, and the fixed default grant', () => {
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Connect Claude Code to Motir?' })).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(screen.getByText('localhost')).toBeTruthy();
    expect(screen.getByText(/An app on this computer/)).toBeTruthy();
    // All projects: no switches — the grant is fixed.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(
      screen.getByText(
        new RegExp(`${DEFAULT_TOKEN_GRANT.length} of ${GRANTABLE_PERMISSIONS.length}`),
      ),
    ).toBeTruthy();
  });

  it('Approve with all projects sends no project and follows the redirect', async () => {
    const calls = stubFetch(200, {
      connectionId: 'k',
      redirectUrl: 'http://127.0.0.1:53682/callback?code=abc',
    });
    const navigate = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls[0]!.url).toBe('/api/oauth/consent');
    expect(calls[0]!.body).toMatchObject({
      action: 'approve',
      workspaceId: 'ws-1',
      projectId: null,
    });
    expect(calls[0]!.body.permissions).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:53682/callback?code=abc');
    expect(screen.getByRole('heading', { name: 'Claude Code is connected' })).toBeTruthy();
  });

  it('One project offers the picker, locks what the person lacks, and sends the narrowed grant', async () => {
    const calls = stubFetch(200, { connectionId: 'k', redirectUrl: 'http://127.0.0.1/cb?code=1' });
    const navigate = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'One project' }));

    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(GRANTABLE_PERMISSIONS.length);
    // Delete is off by default; the permission the person lacks is locked.
    expect(
      screen.getByRole('switch', { name: 'Delete work items' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('switch', { name: 'See every plan' }).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Add comments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const sent = calls[0]!.body.permissions as string[];
    expect(calls[0]!.body.projectId).toBe('p-1');
    expect(sent).not.toContain('comment:add');
    expect(sent).not.toContain('work_item:delete');
    expect(sent).not.toContain('plan:view_any');
  });

  it('an empty One-project grant disables Approve and says why', () => {
    renderScreen({
      ...REQUEST,
      workspaces: [
        {
          ...REQUEST.workspaces[0]!,
          projects: [{ id: 'p-1', key: 'MOTIR', name: 'Motir', grantable: ['project:browse'] }],
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'One project' }));
    fireEvent.click(screen.getByRole('switch', { name: 'View project' }));
    expect(screen.getByRole('alert').textContent).toContain('Grant at least one permission');
    expect(
      (screen.getByRole('button', { name: 'Approve and connect' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('Deny follows the access_denied redirect and shows the denied state', async () => {
    const calls = stubFetch(200, { redirectUrl: 'http://127.0.0.1/cb?error=access_denied' });
    const navigate = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls[0]!.body).toEqual({ action: 'deny', oauthQuery: 'client_id=c1&sig=x' });
    expect(screen.getByRole('heading', { name: 'Claude Code was not connected' })).toBeTruthy();
  });

  it('a request that stopped being usable lands on the refused page, with no redirect', async () => {
    stubFetch(400, { code: 'OAUTH_CONSENT_REQUEST_INVALID', reason: 'expired' });
    const navigate = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await screen.findByRole('heading', { name: 'This connection request can’t be used' });
    expect(screen.getByText(/It is too old to use/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('no workspace at all: Deny only, and it still answers the app', () => {
    renderScreen({ ...REQUEST, workspaces: [], unusableWorkspaces: [] });
    expect(screen.getByRole('heading', { name: 'Claude Code can’t connect yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny and return to Claude Code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and connect' })).toBeNull();
  });

  it('workspaces with nothing grantable are named', () => {
    renderScreen({ ...REQUEST, workspaces: [], unusableWorkspaces: ['A · One', 'A · Two'] });
    expect(screen.getByText(/None of your workspaces lets you grant it anything/)).toBeTruthy();
    expect(screen.getByText(/A · One and A · Two/)).toBeTruthy();
  });
});
