// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DeviceApproval } from '@/app/(auth)/device/_components/DeviceApproval';
import { DeviceSignedOut } from '@/app/(auth)/device/_components/DeviceSignedOut';
import type { DeviceGrantDescriptionDTO } from '@/lib/dto/cliDevice';

// The `/device` approval page (Story MOTIR-1863 · Subtask MOTIR-1867), built to
// `design/cli-connect/`. This suite pins ALL SIX states the design draws plus the
// branches that route between them, because a dead end on this page strands a
// terminal that is still polling — "no unhandled branch" is the acceptance
// criterion, and the only way to hold it is to name every response the three
// endpoints can give and assert where each one lands.
//
// happy-dom + the repo's own matchers (there is no jest-dom here), so assertions
// read `.toBeTruthy()` / `.textContent`, never `.toBeInTheDocument()`.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const GRANT: DeviceGrantDescriptionDTO = {
  userCode: 'K4TP9RXM',
  status: 'pending',
  hostname: 'studio-mbp',
  // Fixed instants: the "asked N ago" line is a relative format, so a live clock
  // would make the assertion a moving target ([[timestamp-assertions-are-windows]]
  // — here the fix is to pin the input, not to widen the expectation).
  askedAt: '2026-07-30T12:00:00.000Z',
  expiresAt: '2026-07-30T12:15:00.000Z',
  scopes: ['read', 'work_items:write', 'integration'],
  clientId: 'motir-cli',
};

const USER = { name: 'Zhu Yue', email: 'zhuyue11@gmail.com', image: null };
const TWO_WORKSPACES = [
  { id: 'ws-1', label: 'moooon · Motir' },
  { id: 'ws-2', label: 'moooon · Side project' },
];

/** One queued response per call, in order — so a test states the whole exchange. */
function stubFetch(...responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500 };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage(props: Partial<Parameters<typeof DeviceApproval>[0]> = {}) {
  return renderWithIntl(
    <DeviceApproval
      initialUserCode=""
      user={USER}
      workspaces={TWO_WORKSPACES}
      activeWorkspaceId="ws-2"
      {...props}
    />,
  );
}

/** Drive entry → confirm with a stubbed describe, and hand back the recorded calls. */
async function reachConfirm(
  props: Partial<Parameters<typeof DeviceApproval>[0]> = {},
  grant: Partial<DeviceGrantDescriptionDTO> = {},
  ...rest: Array<{ status: number; body?: unknown }>
) {
  const calls = stubFetch({ status: 200, body: { ...GRANT, ...grant } }, ...rest);
  renderPage({ initialUserCode: 'K4TP-9RXM', ...props });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Connect this terminal?' });
  return calls;
}

beforeEach(() => {
  push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/device — state 1: code entry (design Panels 1 + 2)', () => {
  it('shows the empty entry form on a bare arrival', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
    expect(screen.getByText('Enter the code your terminal is showing.')).toBeTruthy();
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('');
  });

  it('pre-fills and re-groups the code carried in from `?user_code=`, with its own subhead', () => {
    renderPage({ initialUserCode: 'k4tp9rxm' });
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('K4TP-9RXM');
    expect(
      screen.getByText('Check this is the code your terminal is showing, then continue.'),
    ).toBeTruthy();
    expect(screen.getByText('Filled in from the link your terminal opened.')).toBeTruthy();
  });

  it('normalises a hand-typed code — lower case, a stray space, no dash — before sending it', async () => {
    const calls = stubFetch({ status: 200, body: GRANT });
    renderPage();
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: ' k4tp9rxm ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect this terminal?' });
    expect(calls[0]?.url).toBe('/api/cli/device/grant?user_code=K4TP9RXM');
  });

  it('refuses a short code in the client rather than spending a round trip on it', () => {
    const calls = stubFetch();
    renderPage();
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'K4TP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('A device code is eight characters.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('/device — state 2: confirm (design Panels 3 + 4)', () => {
  it('inventories all four facts: who, what is connecting, which workspace, what scopes', async () => {
    await reachConfirm();

    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    expect(screen.getByText('zhuyue11@gmail.com')).toBeTruthy();
    expect(screen.getByText('Motir CLI on studio-mbp')).toBeTruthy();
    // The code the SERVER matched, echoed in the grouped display form.
    expect(screen.getByText('K4TP-9RXM')).toBeTruthy();
    // Scope NAMES, reused from the API-tokens catalog rather than duplicated.
    expect(screen.getByText('Read everything')).toBeTruthy();
    expect(screen.getByText('Edit work items')).toBeTruthy();
    expect(screen.getByText('Connect integrations')).toBeTruthy();
    expect(screen.getByText('Not: archive or delete work items, members, billing.')).toBeTruthy();
    expect(screen.getByText('In 90 days')).toBeTruthy();
  });

  it('widens the auth column — the fold invariant the design measured lives on this state', async () => {
    const { container } = renderWithIntl(
      <DeviceApproval
        initialUserCode=""
        user={USER}
        workspaces={TWO_WORKSPACES}
        activeWorkspaceId="ws-1"
      />,
    );
    expect(container.querySelector('[data-auth-wide]')).toBeNull();
    cleanup();
    await reachConfirm();
    expect(document.querySelector('[data-auth-wide]')).not.toBeNull();
  });

  it('offers the workspace picker to a multi-workspace user, defaulted to the ACTIVE workspace', async () => {
    await reachConfirm();
    const picker = screen.getByRole('combobox', { name: 'Workspace this terminal can see' });
    expect(picker.textContent).toContain('moooon · Side project'); // activeWorkspaceId = ws-2
    expect(screen.getByText('You belong to 2 — it sees only this one.')).toBeTruthy();
  });

  it('renders NO picker for a single-workspace user — no choice to make, no control', async () => {
    await reachConfirm({ workspaces: [TWO_WORKSPACES[0]!], activeWorkspaceId: 'ws-1' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('moooon · Motir')).toBeTruthy();
    expect(screen.getByText('Your only workspace.')).toBeTruthy();
  });

  it('puts Deny FIRST in the DOM and gives it equal weight — border-danger, never danger TEXT', async () => {
    await reachConfirm();
    const group = screen.getByRole('group', { name: 'Approve or deny this terminal' });
    const buttons = Array.from(group.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Approve and connect']);
    const deny = buttons[0]!;
    // The hue is in the BORDER; the label keeps `--el-text` (the MOTIR-1553 class:
    // `--el-danger-text` is the ink FOR a danger fill, white in the light palette).
    expect(deny.className).toContain('border-(--el-danger)');
    expect(deny.className).not.toContain('text-(--el-danger');
  });

  it('states the phishing warning naming the host that asked', async () => {
    await reachConfirm();
    expect(screen.getByText(/Approve only if you just ran/)).toBeTruthy();
    expect(screen.getByText(/deny it/)).toBeTruthy();
  });
});

describe('/device — state 3: approved (design Panel 5)', () => {
  it('approves against the chosen workspace and names the token that now exists', async () => {
    const calls = await reachConfirm({}, {}, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(calls[1]?.url).toBe('/api/cli/device/approve');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      userCode: 'K4TP9RXM',
      workspaceId: 'ws-2',
    });
    expect(screen.getByText(/CLI · studio-mbp/)).toBeTruthy();
    expect(screen.getByText(/90 days/)).toBeTruthy();
    // The forward path off a terminal screen.
    expect(screen.getByRole('link', { name: 'View API tokens' }).getAttribute('href')).toBe(
      '/settings/account/api-tokens',
    );
  });

  it('announces the result in a live region so it is heard, not just seen', async () => {
    await reachConfirm({}, {}, { status: 200, body: { ok: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    const status = await screen.findByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Terminal connected');
  });

  it('surfaces the server 403 as a real message and STAYS on confirm when the workspace is refused', async () => {
    await reachConfirm({}, {}, { status: 403, body: { code: 'WORKSPACE_FORBIDDEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('not a member of that workspace');
    // Still the confirm screen — the picker that caused it is still on screen.
    expect(screen.getByRole('heading', { name: 'Connect this terminal?' })).toBeTruthy();
  });

  it('routes a 409 (already approved elsewhere) by RE-READING, not by guessing', async () => {
    await reachConfirm(
      {},
      {},
      { status: 409, body: { code: 'DEVICE_GRANT_NOT_PENDING' } },
      { status: 200, body: { ...GRANT, status: 'approved' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve and connect' }));
    await screen.findByRole('heading', { name: 'Terminal connected' });
    expect(screen.getByText(/already approved/)).toBeTruthy();
  });
});

describe('/device — state 4: denied (design Panel 6)', () => {
  it('denies through the plugin endpoint and says nothing was created', async () => {
    const calls = await reachConfirm({}, {}, { status: 200, body: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    await screen.findByRole('heading', { name: 'Request denied' });
    expect(calls[1]?.url).toBe('/api/auth/device/deny');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ userCode: 'K4TP9RXM' });
    expect(screen.getByText(/no token was created/)).toBeTruthy();
  });

  it('offers a way back — "Enter another code" returns to a blank field', async () => {
    await reachConfirm({}, {}, { status: 200, body: { success: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await screen.findByRole('heading', { name: 'Request denied' });

    fireEvent.click(screen.getByRole('button', { name: 'Enter another code' }));
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('');
  });
});

describe('/device — state 5: expired / unknown (design Panel 7)', () => {
  it('renders the expired screen with the "run motir login again" path on a 410', async () => {
    stubFetch({ status: 410, body: { code: 'DEVICE_GRANT_EXPIRED' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'That code has expired' });
    // The lifetime the ADR pinned (15m), not the plugin's 30m default.
    expect(screen.getByText('Codes last 15 minutes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter a new code' })).toBeTruthy();
  });

  it('renders the unknown-code screen on a 404 and KEEPS the field so a typo is one edit away', async () => {
    stubFetch({ status: 404, body: { code: 'DEVICE_GRANT_INVALID' } });
    renderPage({ initialUserCode: 'K4TP-9RXN' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('heading', { name: 'We don’t recognise that code' });
    expect((screen.getByLabelText('Device code') as HTMLInputElement).value).toBe('K4TP-9RXN');
    expect(screen.getByText('One character off is the usual cause.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('names the phishing-relevant 403 — the grant belongs to a different account', async () => {
    stubFetch({ status: 403, body: { code: 'DEVICE_GRANT_FORBIDDEN' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('different Motir account');
  });

  it('never blanks the page on an unroutable failure — a network error is a banner, not a void', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('couldn’t reach Motir');
    expect(screen.getByRole('heading', { name: 'Connect the Motir CLI' })).toBeTruthy();
  });

  it('sends a session that expired mid-flow back through sign-in, code intact', async () => {
    stubFetch({ status: 401, body: { code: 'UNAUTHENTICATED' } });
    renderPage({ initialUserCode: 'K4TP-9RXM' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith('/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM');
  });
});

describe('/device — state 6: signed-out arrival (design Panel 8)', () => {
  it('carries the pending code across sign-in and comes BACK to it', () => {
    renderWithIntl(<DeviceSignedOut userCode="k4tp-9rxm" />);
    expect(screen.getByRole('heading', { name: 'Sign in to connect the CLI' })).toBeTruthy();
    // The code sits in its own `CodeChip`, so it is its own text node.
    expect(screen.getByText('K4TP-9RXM')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in to continue' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fdevice%3Fuser_code%3DK4TP9RXM',
    );
  });

  it('degrades to a bare return when no code came with the URL', () => {
    renderWithIntl(<DeviceSignedOut userCode="" />);
    expect(screen.getByRole('link', { name: 'Sign in to continue' }).getAttribute('href')).toBe(
      '/sign-in?next=%2Fdevice',
    );
  });
});

describe('/device — accessibility', () => {
  // colour-contrast needs real layout + computed colours, which happy-dom does not
  // produce; the design measured those ratios directly (design-notes.md § Token +
  // a11y discipline) and the E2E sweep re-checks them in a real browser. Everything
  // structural — labels, names, roles, listbox shape — is checked here.
  //
  // The sweep runs over `document.body`, which in a test holds only the island — so
  // the `<main>` landmark the shipped `(auth)` layout wraps every page in is put
  // back. Without it axe reports `region` for content the real page always has
  // inside a landmark: an artifact of the harness, not a defect in the screen.
  const options = { rules: { 'color-contrast': { enabled: false } } } as const;

  // Swept against `document.body`, which in a test holds only the island — so the
  // `<main>` landmark the shipped `(auth)` layout wraps every page in is added back
  // here. Without it axe reports `region` for content the real page always has in a
  // landmark, which would be an artifact of the harness, not a defect in the screen.
  function renderInLandmark(initialUserCode: string) {
    const main = document.createElement('main');
    document.body.appendChild(main);
    return renderWithIntl(
      <DeviceApproval
        initialUserCode={initialUserCode}
        user={USER}
        workspaces={TWO_WORKSPACES}
        activeWorkspaceId="ws-2"
      />,
      { container: main },
    );
  }

  it('the entry screen is clean', async () => {
    stubFetch();
    renderInLandmark('K4TP-9RXM');
    const result = await axe.run(document.body, options);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 30_000);

  it('the confirm screen is clean, picker and all', async () => {
    stubFetch({ status: 200, body: GRANT });
    renderInLandmark('K4TP-9RXM');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Connect this terminal?' });

    const result = await axe.run(document.body, options);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  }, 30_000);
});
