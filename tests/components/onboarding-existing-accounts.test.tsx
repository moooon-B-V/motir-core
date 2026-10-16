// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import type { MigrateConnectOutcome, MigrateConnectStateDto } from '@/lib/dto/migrateOnboarding';
import type { GithubAccountForOrganizationDTO } from '@/lib/dto/github';

// MOTIR-8762 — the connect step's already-installed accounts: the list, the
// GitHub sign-in prompt and the admin gate (`design/onboarding-migrate/`
// Revision 8, panels 2l–2o, 2s.vii, 2t). Both reads are faked at `fetch`, the
// sign-in's return at the address (`?github=`). What MOTIR-8220's route decides
// — who may list, what is linked — is `tests/github/`'s to prove.

const query: { current: URLSearchParams } = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => query.current,
  usePathname: () => '/onboarding/migrate',
}));

import {
  ConnectPanel,
  type ConnectAdvanceResult,
} from '@/app/(onboarding)/onboarding/migrate/_components/ConnectPanel';
import { installedAccountsFrom } from '@/app/(onboarding)/onboarding/migrate/_components/useInstalledAccounts';

const c = enMessages.onboardingMigrate.connect;
const e = c.existing;
const RUN = 'run-1';
const ORG = 'org-1';
const ACCOUNTS_URL = `/api/organizations/${ORG}/github/accounts`;

function makeState(outcome: MigrateConnectOutcome): MigrateConnectStateDto {
  const usable = outcome === 'connected' || outcome === 'already_connected';
  const bound = usable || outcome === 'no_repositories_selected';
  return {
    organizationId: ORG,
    installation: {
      bound,
      accounts: bound
        ? [{ installationRef: '4242', accountLogin: 'acme', accountType: 'Organization' }]
        : [],
    },
    repositories: usable
      ? [{ provider: 'github', repoRef: 'acme/web', defaultBranch: 'main' }]
      : [],
    outcome,
    snapshot: 'mcs1.cnVuLTE',
  };
}

const ACME: GithubAccountForOrganizationDTO = {
  installationId: '101',
  accountLogin: 'acme-labs',
  accountType: 'Organization',
  avatarUrl: 'https://avatars.example/acme.png',
  visibleRepoCount: 12,
  linkState: 'linked_here',
};
const DANA: GithubAccountForOrganizationDTO = {
  installationId: '202',
  accountLogin: 'dana-okafor',
  accountType: 'User',
  avatarUrl: null,
  visibleRepoCount: null,
  linkState: 'not_linked',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Answer = { status: number; body: unknown };
const ok = (accounts: GithubAccountForOrganizationDTO[]): Answer => ({
  status: 200,
  body: { state: 'ok', accounts },
});
const IDENTITY: Answer = { status: 200, body: { state: 'identity_required' } };

/** Fakes the connect read (one fixed answer) and the accounts read (`answers`
 *  consumed in order; the last repeats). */
function fake(connect: MigrateConnectStateDto, ...answers: Answer[]) {
  const queue = [...answers];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/onboarding/migrate/${RUN}/connect-state`)) return json(connect);
    if (url === ACCOUNTS_URL) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return json(next.body, next.status);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const accountReads = (spy: ReturnType<typeof fake>) =>
  spy.mock.calls.filter(([input]) => String(input) === ACCOUNTS_URL);

function arriveAt(search: string) {
  window.history.replaceState(null, '', `/onboarding/migrate${search}`);
  query.current = new URLSearchParams(search);
}

function renderStep() {
  const onAdvance = vi.fn(async (): Promise<ConnectAdvanceResult> => ({ kind: 'ok' }));
  return renderWithIntl(<ConnectPanel runId={RUN} onAdvance={onAdvance} busy={false} />);
}

/** Flush the deferred connect read, then the accounts read it starts. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  arriveAt('');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accounts listed (2l)', () => {
  it('shows each account with its avatar, login, type, link mark and one pick, and the install row below', async () => {
    fake(makeState('not_started'), ok([DANA, ACME]));
    renderStep();
    await settle();

    const region = screen.getByTestId('connect-state-preflight');
    const list = within(region).getByTestId('existing-accounts');
    expect(within(list).getByText(e.title)).toBeTruthy();
    expect(within(list).getByText(e.hint)).toBeTruthy();

    const rows = within(list).getAllByTestId('existing-account-row');
    // Sorted by login, as the Settings picker lists them.
    expect(rows.map((r) => r.getAttribute('data-installation-id'))).toEqual(['101', '202']);

    const acme = screen.getByRole('button', { name: `Choose repositories from acme-labs` });
    expect(acme.querySelector('img')?.getAttribute('src')).toBe(ACME.avatarUrl);
    expect(within(acme).getByText(e.typeOrg)).toBeTruthy();
    expect(within(acme).getByText(e.linkedHere)).toBeTruthy();
    expect(within(acme).getByText(e.pickCta)).toBeTruthy();

    const dana = screen.getByRole('button', { name: `Choose repositories from dana-okafor` });
    expect(dana.querySelector('img')).toBeNull();
    expect(within(dana).getByText('D')).toBeTruthy();
    expect(within(dana).getByText(e.typeUser)).toBeTruthy();
    expect(within(dana).queryByText(e.linkedHere)).toBeNull();
    expect(within(dana).queryByTestId('existing-account-linked')).toBeNull();

    // The install control is the list's last row, relabelled — and the only one.
    const install = screen.getByTestId('connect-start');
    expect(install.textContent).toContain(e.installAnotherCta);
    expect(install.textContent).toContain(e.installAnotherHint);
    expect(screen.getAllByTestId('connect-start')).toHaveLength(1);
    expect(list.contains(install)).toBe(true);
    expect(
      rows.every((r) => r.compareDocumentPosition(install) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    // The list replaces the pre-flight's lone Connect GitHub (behaviour 2).
    expect(screen.queryByTestId('connect-preflight')).toBeNull();
    expect(screen.queryByText(c.preflightCta)).toBeNull();
  });

  it('a pick reads that account’s repositories and posts no link', async () => {
    const spy = fake(makeState('not_started'), ok([ACME]));
    renderStep();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose repositories from acme-labs' }));
    });
    // The picker behind the pick is MOTIR-8763's (its own test file).
    expect(spy.mock.calls.some(([u]) => String(u).endsWith('/accounts/101/repositories'))).toBe(
      true,
    );
    expect(
      spy.mock.calls.some(
        (call) =>
          (call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).method === 'POST',
      ),
    ).toBe(false);
  });

  it('pressing the install row is the step’s own install press', async () => {
    fake(makeState('not_started'), ok([ACME]));
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: {} } as unknown as Window);
    renderStep();
    await settle();
    fireEvent.click(screen.getByTestId('connect-start'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toContain('/api/github/install/start');
    // Starting draws the shipped press; the list is not rendered there.
    expect(screen.getByTestId('connect-state-starting')).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
  });
});

describe('no accounts (2n)', () => {
  it('renders exactly the shipped step — no list, no hint, no prompt, no extra node', async () => {
    fake(makeState('not_started'), ok([]));
    const { container } = renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-preflight');
    expect(within(region).getByTestId('connect-preflight')).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(c.preflightCta);
    expect(container.querySelector('[data-testid^="existing-"]')).toBeNull();
    for (const text of [e.title, e.hint, e.identity.title, e.installAnotherCta, e.loading]) {
      expect(screen.queryByText(text)).toBeNull();
    }
  });
});

describe('the GitHub sign-in prompt (2o)', () => {
  it('asks for the sign-in with a link back to this step, and a visible skip', async () => {
    fake(makeState('not_started'), IDENTITY);
    renderStep();
    await settle();
    const prompt = screen.getByTestId('existing-accounts-identity-prompt');
    expect(within(prompt).getByText(e.identity.title)).toBeTruthy();
    expect(within(prompt).getByText(e.identity.hint)).toBeTruthy();
    const signIn = within(prompt).getByRole('link', { name: e.identity.cta });
    expect(signIn.getAttribute('href')).toBe(
      '/api/github/oauth/start?from=onboardingMigrateConnect',
    );
    expect(within(prompt).getByRole('button', { name: e.identity.skipCta })).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(e.installAnotherCta);
    expect(within(prompt).queryByText(e.identity.declinedHint)).toBeNull();
  });

  it('skip removes the prompt and leaves the shipped pre-flight and its install', async () => {
    fake(makeState('not_started'), IDENTITY);
    renderStep();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: e.identity.skipCta }));
    });
    expect(screen.queryByTestId('existing-accounts-identity-prompt')).toBeNull();
    expect(screen.getByTestId('connect-preflight')).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(c.preflightCta);
  });

  it('back from the sign-in (?github=connected), the list shows and no stale prompt does', async () => {
    arriveAt('?github=connected');
    fake(makeState('not_started'), ok([ACME]));
    renderStep();
    await settle();
    expect(screen.getByTestId('existing-accounts')).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts-identity-prompt')).toBeNull();
    expect(screen.queryByText(e.identity.title)).toBeNull();
  });

  it.each(['denied', 'state_error', 'error'])(
    '?github=%s leaves the prompt up with one benign line, never a danger tone',
    async (status) => {
      arriveAt(`?github=${status}`);
      fake(makeState('not_started'), IDENTITY);
      const { container } = renderStep();
      await settle();
      const prompt = screen.getByTestId('existing-accounts-identity-prompt');
      expect(within(prompt).getByText(e.identity.declinedHint)).toBeTruthy();
      expect(screen.getByTestId('connect-state-preflight')).toBeTruthy();
      expect(container.querySelector('[data-tone="danger"]')).toBeNull();
      expect(container.innerHTML).not.toContain('--el-danger');
    },
  );
});

describe('not an organisation admin (2s.vii)', () => {
  it('a refusal from the accounts read replaces the list and the prompt with one sentence; install stays', async () => {
    fake(makeState('not_started'), {
      status: 403,
      body: { code: 'ORG_FORBIDDEN', error: 'no' },
    });
    renderStep();
    await settle();
    const block = screen.getByTestId('existing-accounts-not-admin');
    expect(within(block).getByText(e.outcome.notAdminTitle)).toBeTruthy();
    expect(within(block).getByText(e.outcome.notAdminHint)).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
    expect(screen.queryByTestId('existing-accounts-identity-prompt')).toBeNull();
    expect(screen.getByTestId('connect-start').textContent).toContain(e.installAnotherCta);
  });

  it('tells the two 403s apart by the body code, never the status', async () => {
    const notAdmin = await installedAccountsFrom(json({ code: 'ORG_FORBIDDEN' }, 403));
    const notAccessible = await installedAccountsFrom(
      json({ code: 'installation_not_accessible' }, 403),
    );
    expect(notAdmin).toEqual({ kind: 'not_admin' });
    expect(notAccessible).toEqual({ kind: 'failed' });
  });
});

describe('loading and could not read (2m)', () => {
  it('a failed read shows the load error with retry and the install row; retry reads again', async () => {
    const spy = fake(makeState('not_started'), { status: 500, body: {} }, ok([ACME]));
    renderStep();
    await settle();
    const block = screen.getByTestId('existing-accounts-failed');
    expect(within(block).getByText(e.loadErrorTitle)).toBeTruthy();
    expect(within(block).getByText(e.loadErrorHint)).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(e.installAnotherCta);
    expect(accountReads(spy)).toHaveLength(1);

    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: e.retryCta }));
    });
    // The retry shows the loading line until the answer lands.
    await act(async () => {});
    expect(accountReads(spy)).toHaveLength(2);
    expect(screen.getByTestId('existing-accounts')).toBeTruthy();
  });

  it('a failed accounts read leaves the step’s own state and its Continue untouched', async () => {
    fake(makeState('already_connected'), { status: 500, body: {} });
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-already_connected')).toBeTruthy();
    expect(screen.getByText(c.alreadyConnectedTitle)).toBeTruthy();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
    expect(screen.getByTestId('existing-accounts-failed')).toBeTruthy();
  });

  it('the loading line shows under the step until the accounts answer', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === ACCOUNTS_URL
          ? new Promise<Response>((r) => (release = r))
          : json(makeState('not_started')),
      ),
    );
    renderStep();
    await settle();
    const loading = screen.getByTestId('existing-accounts-loading');
    expect(within(loading).getByText(e.loading)).toBeTruthy();
    expect(loading.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      release(json({ state: 'ok', accounts: [ACME] }));
    });
    await act(async () => {});
    expect(screen.queryByTestId('existing-accounts-loading')).toBeNull();
    expect(screen.getByTestId('existing-accounts')).toBeTruthy();
  });
});

describe('where the list renders (2t)', () => {
  it('never in checking — the accounts are not read before the connect read lands', async () => {
    const spy = fake(makeState('not_started'), ok([ACME]));
    renderStep();
    expect(screen.getByTestId('connect-state-checking')).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
    expect(accountReads(spy)).toHaveLength(0);
    await settle();
  });

  it('never in connected', async () => {
    fake(makeState('connected'), ok([ACME]));
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-connected')).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
    expect(screen.queryByTestId('connect-start')).toBeNull();
  });

  it('never in waiting', async () => {
    fake(makeState('not_started'), ok([ACME]));
    vi.spyOn(window, 'open').mockReturnValue({ opener: {} } as unknown as Window);
    renderStep();
    await settle();
    fireEvent.click(screen.getByTestId('connect-start'));
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.getByTestId('connect-state-waiting')).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
  });

  it('below the connected summary in already_connected, with Continue kept', async () => {
    fake(makeState('already_connected'), ok([ACME]));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-already_connected');
    const title = within(region).getByText(c.alreadyConnectedTitle);
    const list = within(region).getByTestId('existing-accounts');
    expect(title.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
  });

  it.each([
    ['install_requested', 'owner_pending', c.ownerPendingTitle],
    ['install_unbound', 'install_cancelled', c.cancelledTitle],
  ] as const)(
    '?github=%s keeps the list above its own line, with no second install',
    async (status, state, line) => {
      arriveAt(`?github=${status}`);
      fake(makeState('not_started'), ok([ACME]));
      renderStep();
      await settle();
      const region = screen.getByTestId(`connect-state-${state}`);
      const list = within(region).getByTestId('existing-accounts');
      const text = within(region).getByText(line);
      expect(list.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByTestId('connect-start')).toHaveLength(1);
      expect(screen.queryByText(c.ownerPendingOpenCta)).toBeNull();
    },
  );

  it('a failed install keeps its line above the list', async () => {
    arriveAt('?github=install_expired');
    fake(makeState('not_started'), ok([ACME]));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-failed');
    const line = within(region).getByText(c.outcome.install_expiredTitle);
    const list = within(region).getByTestId('existing-accounts');
    expect(line.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('connect-start')).toHaveLength(1);
  });
});
