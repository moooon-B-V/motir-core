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
const signOut = vi.fn(async () => undefined);
vi.mock('@/lib/auth/client', () => ({ signOut: () => signOut() }));

const REQUEST: ConsentRequestDto = {
  client: { clientId: 'c1', name: 'Claude Code', verification: { kind: 'self' } },
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

function renderScreen(
  request: ConsentRequestDto = REQUEST,
  opts: { user?: { name: string; email: string }; activeWorkspaceId?: string | null } = {},
) {
  const navigate = vi.fn();
  renderWithIntl(
    <ConsentScreen
      oauthQuery="client_id=c1&sig=x"
      request={request}
      user={opts.user ?? { name: 'Zhu Yue', email: 'zhuyue11@gmail.com' }}
      activeWorkspaceId={opts.activeWorkspaceId ?? null}
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
  signOut.mockClear();
});

describe('ConsentScreen — who vouches for the app (MOTIR-7174)', () => {
  // `design/auth/oauth-consent--verified-client.mock.html` Panels V1–V2.
  function withVerification(
    verification: ConsentRequestDto['client']['verification'],
    name: string | null = 'Claude',
  ): ConsentRequestDto {
    return {
      ...REQUEST,
      client: { clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', name, verification },
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      redirectHost: 'claude.ai',
      loopback: false,
    };
  }

  it('verified by domain: the host is the title and the app, the name is its own claim', () => {
    renderScreen(withVerification({ kind: 'domain', host: 'claude.ai' }));
    expect(screen.getByRole('heading', { name: 'Connect claude.ai to Motir?' })).toBeTruthy();
    expect(screen.getByText('Verified domain')).toBeTruthy();
    expect(screen.queryByText('Unverified')).toBeNull();
    expect(
      screen.getByText(
        'Calls itself “Claude” — a name it chose. Motir checked that claude.ai publishes it.',
      ),
    ).toBeTruthy();
    const app = screen.getAllByText('claude.ai').find((el) => el.className.includes('font-mono'));
    expect(app).toBeTruthy();
  });

  it('a document calling itself “Claude” on another host reads as THAT host', () => {
    renderScreen(withVerification({ kind: 'domain', host: 'evil.example' }));
    expect(screen.getByRole('heading', { name: 'Connect evil.example to Motir?' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Claude/ })).toBeNull();
    expect(screen.getByText(/Calls itself “Claude”.*evil\.example publishes it/)).toBeTruthy();
  });

  it('self-registered: the shipped Unverified pill and line', () => {
    renderScreen(withVerification({ kind: 'self' }));
    expect(screen.getByRole('heading', { name: 'Connect Claude to Motir?' })).toBeTruthy();
    expect(screen.getByText('Unverified')).toBeTruthy();
    expect(screen.queryByText('Verified domain')).toBeNull();
    expect(screen.getByText(/It registered itself/)).toBeTruthy();
  });

  it('registered: no pill, and the registered line', () => {
    renderScreen(withVerification({ kind: 'registered' }));
    expect(screen.queryByText('Unverified')).toBeNull();
    expect(screen.queryByText('Verified domain')).toBeNull();
    expect(screen.getByText(/Registered with this Motir ahead of time/)).toBeTruthy();
  });
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

  it('a workspace with no projects offers nothing to pick under One project, and cannot approve', () => {
    renderScreen({
      ...REQUEST,
      workspaces: [{ id: 'ws-1', label: 'moooon · Empty', projects: [] }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'One project' }));
    expect(screen.queryAllByRole('switch').every((s) => s.hasAttribute('disabled'))).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Approve and connect' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('workspaces with nothing grantable are named', () => {
    renderScreen({ ...REQUEST, workspaces: [], unusableWorkspaces: ['A · One', 'A · Two'] });
    expect(screen.getByText(/None of your workspaces lets you grant it anything/)).toBeTruthy();
    expect(screen.getByText(/A · One and A · Two/)).toBeTruthy();
  });

  describe('when the press fails', () => {
    it.each([
      [404, { code: 'WORKSPACE_NOT_FOUND' }, 'any more. Pick another one.'],
      [404, { code: 'PROJECT_NOT_FOUND' }, 'any more. Pick another one.'],
      [422, { code: 'API_TOKEN_INVALID_PERMISSION' }, 'Reload the page'],
      [500, { code: 'BOOM' }, 'nothing was connected'],
      [502, 'not json', 'nothing was connected'],
    ])('a %i (%j) keeps the screen and says what to do', async (status, body, says) => {
      stubFetch(status, body);
      const navigate = renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(says);
      expect(navigate).not.toHaveBeenCalled();
      expect(
        (screen.getByRole('button', { name: 'Approve and connect' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    it('a network failure says so', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('offline');
        }),
      );
      renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t reach Motir');
    });

    it('a lapsed session goes back through sign-in', async () => {
      stubFetch(401, { code: 'UNAUTHENTICATED' });
      renderScreen();
      fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/sign-in'));
    });
  });

  it('several workspaces: opens on the active one, and switching resets the project and grant', async () => {
    const calls = stubFetch(200, { connectionId: 'k', redirectUrl: 'http://127.0.0.1/cb?code=1' });
    const two: ConsentRequestDto = {
      ...REQUEST,
      client: { ...REQUEST.client, verification: { kind: 'registered' } },
      workspaces: [
        REQUEST.workspaces[0]!,
        {
          id: 'ws-2',
          label: 'moooon · Labs',
          projects: [
            { id: 'p-2', key: 'LAB', name: 'Lab', grantable: [...GRANTABLE_PERMISSIONS] },
            { id: 'p-3', key: 'OPS', name: 'Ops', grantable: ['project:browse'] },
          ],
        },
      ],
    };
    const navigate = renderScreen(two, { activeWorkspaceId: 'ws-2' });
    // A client Motir registered is said to be, and carries no Unverified pill.
    expect(screen.getByText(/Registered with this Motir ahead of time/)).toBeTruthy();
    expect(screen.queryByText('Unverified')).toBeNull();

    const picker = screen.getByRole('combobox', { name: 'Workspace Claude Code can act in' });
    expect(picker.textContent).toContain('Labs');
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'moooon · Motir' }));
    fireEvent.click(screen.getByRole('button', { name: 'One project' }));
    expect(screen.getByRole('combobox', { name: 'Project' }).textContent).toContain('MOTIR');

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'moooon · Labs' }));
    const project = screen.getByRole('combobox', { name: 'Project' });
    fireEvent.click(project);
    fireEvent.click(screen.getByRole('option', { name: /OPS/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(calls[0]!.body).toMatchObject({
      workspaceId: 'ws-2',
      projectId: 'p-3',
      permissions: ['project:browse'],
    });
  });

  it('a second press while the first is in flight sends nothing more', async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
    vi.stubGlobal('fetch', fetchMock);
    const navigate = renderScreen();
    const approve = screen.getByRole('button', { name: 'Approve and connect' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(
      new Response(JSON.stringify({ connectionId: 'k', redirectUrl: 'http://127.0.0.1/cb' }), {
        status: 200,
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('http://127.0.0.1/cb'));
  });

  it('an app with no name, or a blank one, is still named and tiled', () => {
    renderScreen({ ...REQUEST, client: { ...REQUEST.client, name: null } });
    expect(screen.getAllByText(/This app/).length).toBeGreaterThan(0);
    cleanup();
    renderScreen({ ...REQUEST, client: { ...REQUEST.client, name: '   ' } });
    expect(screen.getByText('?')).toBeTruthy();
    cleanup();
    // A person with neither a name nor a usable email still gets a tile.
    renderScreen(REQUEST, { user: { name: '', email: ' ' } });
    expect(screen.getAllByText('?').length).toBeGreaterThan(0);
  });

  it('Not you? signs out and goes to sign-in', async () => {
    renderScreen(REQUEST, { user: { name: '', email: 'someone@example.com' } });
    expect(screen.getAllByText('someone@example.com').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/sign-in'));
    expect(signOut).toHaveBeenCalledOnce();
  });
});
