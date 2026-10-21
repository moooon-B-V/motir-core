// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import type { MigrateConnectStateDto } from '@/lib/dto/migrateOnboarding';
import type {
  GithubAccountForOrganizationDTO,
  GithubAccountRepositoriesDTO,
} from '@/lib/dto/github';

// MOTIR-8763 — the connect step's repository picker: the three row kinds, the
// nothing-left panel, loading and error, and the install round trip's
// `select_repos` opening it (`design/onboarding-migrate/` Revision 8, panels
// 2p, 2q, 2r). The reads are faked at `fetch`; the arrival at the address.
// Which repository is available is MOTIR-8220's to decide and `tests/github/`'s
// to prove — here the answers are rendered one to one.

const query: { current: URLSearchParams } = { current: new URLSearchParams() };
const replaced: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => query.current,
  usePathname: () => '/onboarding/migrate',
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowReplace: (href: string) => {
    replaced.push(href);
  },
  shallowPush: vi.fn(),
}));

import {
  ConnectPanel,
  type ConnectAdvanceResult,
} from '@/app/(onboarding)/onboarding/migrate/_components/ConnectPanel';
import { accountRepositoriesFrom } from '@/app/(onboarding)/onboarding/migrate/_components/useAccountRepositories';

const c = enMessages.onboardingMigrate.connect;
const e = c.existing;
const gp = enMessages.github.picker;
const RUN = 'run-1';
const ORG = 'org-1';
const ACCOUNTS_URL = `/api/organizations/${ORG}/github/accounts`;
const reposUrl = (id: string) => `${ACCOUNTS_URL}/${id}/repositories`;

const STATE: MigrateConnectStateDto = {
  organizationId: ORG,
  installation: { bound: false, accounts: [] },
  repositories: [],
  outcome: 'not_started',
  snapshot: 'mcs1.cnVuLTE',
};

const ACME: GithubAccountForOrganizationDTO = {
  installationId: '101',
  accountLogin: 'acme-labs',
  accountType: 'Organization',
  avatarUrl: null,
  visibleRepoCount: 3,
  linkState: 'not_linked',
};

function repos(rows: GithubAccountRepositoriesDTO['repos']): GithubAccountRepositoriesDTO {
  return {
    repos: rows,
    counts: {
      available: rows.filter((r) => r.availability === 'available').length,
      connectedHere: rows.filter((r) => r.availability === 'connected_here').length,
      connectedElsewhere: rows.filter((r) => r.availability === 'connected_elsewhere').length,
    },
  };
}

const THREE_KINDS = repos([
  { repoId: '1', fullName: 'acme-labs/web', availability: 'available' },
  { repoId: '2', fullName: 'acme-labs/api', availability: 'available' },
  { repoId: '3', fullName: 'acme-labs/docs', availability: 'connected_here' },
  { repoId: '4', fullName: 'acme-labs/ios', availability: 'connected_elsewhere' },
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Answer = { status: number; body: unknown };

/** Fakes the three reads. `repoAnswers` is consumed in order; the last repeats. */
function fake(opts: { accounts?: Answer; repoAnswers?: Answer[] }) {
  const accounts = opts.accounts ?? { status: 200, body: { state: 'ok', accounts: [ACME] } };
  const queue = [...(opts.repoAnswers ?? [{ status: 200, body: THREE_KINDS }])];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/onboarding/migrate/${RUN}/connect-state`)) return json(STATE);
    if (url === ACCOUNTS_URL) return json(accounts.body, accounts.status);
    if (url.endsWith('/repositories')) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return json(next.body, next.status);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function arriveAt(search: string) {
  window.history.replaceState(null, '', `/onboarding/migrate${search}`);
  query.current = new URLSearchParams(search);
}

function renderStep() {
  const onAdvance = vi.fn(async (): Promise<ConnectAdvanceResult> => ({ kind: 'ok' }));
  return renderWithIntl(<ConnectPanel runId={RUN} onAdvance={onAdvance} busy={false} />);
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {});
  await act(async () => {});
}

async function pickAcme() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose repositories from acme-labs' }));
  });
  await act(async () => {});
}

const rowOf = (name: string) =>
  screen
    .getAllByTestId('existing-picker-row')
    .find((r) => r.textContent?.includes(name)) as HTMLElement;
const boxOf = (name: string) => within(rowOf(name)).getByRole('checkbox');

beforeEach(() => {
  arriveAt('');
  replaced.length = 0;
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('picking an account opens its picker (2p.i)', () => {
  it('heads with the login and renders the three row kinds, each with a mark and its words', async () => {
    const spy = fake({});
    renderStep();
    await settle();
    await pickAcme();

    expect(spy.mock.calls.some(([u]) => String(u) === reposUrl('101'))).toBe(true);
    const picker = screen.getByTestId('existing-repository-picker');
    expect(within(picker).getByText('Repositories in acme-labs')).toBeTruthy();
    expect(within(picker).getByText(e.picker.hint)).toBeTruthy();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
    expect(within(picker).queryByText(e.picker.fromInstallHint)).toBeNull();

    expect(rowOf('web').getAttribute('data-availability')).toBe('available');
    expect(within(rowOf('web')).getByText(e.picker.available)).toBeTruthy();
    expect((boxOf('web') as HTMLButtonElement).disabled).toBe(false);

    expect(rowOf('docs').getAttribute('data-availability')).toBe('connected_here');
    expect(within(rowOf('docs')).getByText(e.picker.connectedHere)).toBeTruthy();
    expect(boxOf('docs').getAttribute('aria-checked')).toBe('true');
    expect((boxOf('docs') as HTMLButtonElement).disabled).toBe(true);

    expect(rowOf('ios').getAttribute('data-availability')).toBe('connected_elsewhere');
    expect(within(rowOf('ios')).getByText(e.picker.connectedElsewhere)).toBeTruthy();
    expect(within(rowOf('ios')).getByText(e.picker.connectedElsewhereHint)).toBeTruthy();
    expect((boxOf('ios') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a connected-elsewhere row names nobody, whatever else the response carried', async () => {
    fake({
      repoAnswers: [
        {
          status: 200,
          body: {
            repos: [
              {
                repoId: '9',
                fullName: 'acme-labs/secret',
                availability: 'connected_elsewhere',
                organizationName: 'Globex Corp',
                projectName: 'Project Zeus',
              },
            ],
            counts: { available: 0, connectedHere: 0, connectedElsewhere: 1 },
            owner: 'Globex Corp',
          },
        },
      ],
    });
    const { container } = renderStep();
    await settle();
    await pickAcme();
    expect(container.textContent).not.toContain('Globex');
    expect(container.textContent).not.toContain('Zeus');
  });

  it('only available rows toggle; the counter and Connect N follow, and Connect is disabled at 0', async () => {
    fake({});
    renderStep();
    await settle();
    await pickAcme();

    const confirm = screen.getByTestId('existing-picker-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(e.outcome.selectionRequiredTitle)).toBeTruthy();
    expect(screen.getByTestId('existing-picker-count').textContent).toBe('0 repositories selected');

    fireEvent.click(boxOf('docs'));
    fireEvent.click(boxOf('ios'));
    expect(screen.getByTestId('existing-picker-count').textContent).toBe('0 repositories selected');

    fireEvent.click(boxOf('web'));
    expect(screen.getByTestId('existing-picker-count').textContent).toBe('1 repository selected');
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toContain('Connect 1 repository');
    expect(screen.queryByText(e.outcome.selectionRequiredTitle)).toBeNull();

    fireEvent.click(boxOf('api'));
    expect(confirm.textContent).toContain('Connect 2 repositories');
  });

  it('Back returns to the account list', async () => {
    fake({});
    renderStep();
    await settle();
    await pickAcme();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: e.picker.backCta }));
    });
    expect(screen.queryByTestId('existing-repository-picker')).toBeNull();
    expect(screen.getByTestId('existing-accounts')).toBeTruthy();
  });

  it('a long list scrolls inside the card while the footer stays outside it', async () => {
    const many = repos(
      Array.from({ length: 54 }, (_, i) => ({
        repoId: String(i + 1),
        fullName: `acme-labs/repo-${String(i + 1).padStart(2, '0')}`,
        availability: 'available' as const,
      })),
    );
    fake({ repoAnswers: [{ status: 200, body: many }] });
    renderStep();
    await settle();
    await pickAcme();
    const list = screen.getByTestId('existing-picker-list');
    expect(within(list).getAllByTestId('existing-picker-row')).toHaveLength(54);
    expect(list.className).toContain('overflow-y-auto');
    expect(list.contains(screen.getByTestId('existing-picker-footer'))).toBe(false);
  });
});

describe('nothing left (2q)', () => {
  it('replaces the list with both counts, the GitHub link and choose another', async () => {
    fake({
      repoAnswers: [
        {
          status: 200,
          body: repos([
            { repoId: '3', fullName: 'acme-labs/docs', availability: 'connected_here' },
            { repoId: '4', fullName: 'acme-labs/ios', availability: 'connected_elsewhere' },
            { repoId: '5', fullName: 'acme-labs/tv', availability: 'connected_elsewhere' },
          ]),
        },
      ],
    });
    renderStep();
    await settle();
    await pickAcme();
    const panel = screen.getByTestId('existing-picker-nothing-left');
    expect(within(panel).getByText(e.picker.nothingLeftTitle)).toBeTruthy();
    expect(within(panel).getByText(e.picker.nothingLeftHint)).toBeTruthy();
    expect(within(screen.getByTestId('existing-picker-count-here')).getByText('1')).toBeTruthy();
    expect(
      within(screen.getByTestId('existing-picker-count-elsewhere')).getByText('2'),
    ).toBeTruthy();
    const link = within(panel).getByRole('link');
    expect(link.textContent).toContain(e.picker.nothingLeftCta);
    expect(link.getAttribute('href')).toBe(
      'https://github.com/organizations/acme-labs/settings/installations/101',
    );
    expect(screen.queryByTestId('existing-picker-list')).toBeNull();
    expect(screen.queryByTestId('existing-picker-confirm')).toBeNull();
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: gp.noneLeft.chooseAnother }));
    });
    expect(screen.getByTestId('existing-accounts')).toBeTruthy();
  });
});

describe('loading and error (2p.ii, 2p.iii)', () => {
  it('shows the loading line, then a failed read with retry that reads again', async () => {
    let release: (r: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === ACCOUNTS_URL) return json({ state: 'ok', accounts: [ACME] });
        if (url.endsWith('/repositories')) {
          calls += 1;
          if (calls === 1) return new Promise<Response>((r) => (release = r));
          return json(THREE_KINDS);
        }
        return json(STATE);
      }),
    );
    renderStep();
    await settle();
    await pickAcme();
    expect(
      within(screen.getByTestId('existing-picker-loading')).getByText(e.picker.loading),
    ).toBeTruthy();
    await act(async () => {
      release(json({ code: 'boom' }, 500));
    });
    await act(async () => {});
    expect(screen.getByText(gp.reposError.title)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: gp.retry }));
    });
    await act(async () => {});
    expect(calls).toBe(2);
    expect(screen.getAllByTestId('existing-picker-row')).toHaveLength(4);
  });
});

describe('the install round trip’s select_repos arrival (2r)', () => {
  it('opens the picker for that installation with the notice, and drops the pair from the address', async () => {
    arriveAt('?github=select_repos&installation_id=101');
    const spy = fake({});
    renderStep();
    await settle();
    const picker = screen.getByTestId('existing-repository-picker');
    expect(within(picker).getByText(e.picker.fromInstallHint)).toBeTruthy();
    expect(within(picker).getByText('Repositories in acme-labs')).toBeTruthy();
    expect(spy.mock.calls.some(([u]) => String(u) === reposUrl('101'))).toBe(true);
    const last = replaced.at(-1)!;
    expect(last).not.toContain('github=');
    expect(last).not.toContain('installation_id=');
  });

  it('an installation the person cannot reach does not open the picker; the line and an install control show', async () => {
    arriveAt('?github=select_repos&installation_id=777');
    fake({
      accounts: { status: 200, body: { state: 'identity_required' } },
      repoAnswers: [{ status: 403, body: { code: 'installation_not_accessible' } }],
    });
    renderStep();
    await settle();
    expect(screen.queryByTestId('existing-repository-picker')).toBeNull();
    expect(screen.getByText(c.outcome.installation_not_accessibleTitle)).toBeTruthy();
    expect(screen.getByTestId('existing-accounts-identity-prompt')).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(e.installAnotherCta);
  });
});

describe('the wire shape', () => {
  it('maps the not-accessible 403 by its code, and anything else that fails to failed', async () => {
    expect(
      await accountRepositoriesFrom(json({ code: 'installation_not_accessible' }, 403)),
    ).toEqual({ kind: 'not_accessible' });
    expect(await accountRepositoriesFrom(json({ code: 'ORG_FORBIDDEN' }, 403))).toEqual({
      kind: 'failed',
    });
    expect(await accountRepositoriesFrom(json({}, 500))).toEqual({ kind: 'failed' });
  });
});
