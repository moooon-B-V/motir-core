// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import type { MigrateConnectOutcome, MigrateConnectStateDto } from '@/lib/dto/migrateOnboarding';
import type {
  GithubAccountForOrganizationDTO,
  GithubAccountRepositoriesDTO,
} from '@/lib/dto/github';

// MOTIR-8764 — confirming links the chosen repositories and the connect step
// says what happened, one next action each (`design/onboarding-migrate/`
// Revision 8, panels 2s.i–2s.vii). The link route is faked at `fetch` with the
// wire shapes MOTIR-8220 ships (`lib/github/linkErrorResponse.ts`,
// `lib/organizations/errorResponse.ts`); whether a repository really is taken is
// `tests/github/`'s and the integration card's to prove.

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
import { linkResultFrom } from '@/app/(onboarding)/onboarding/migrate/_components/useLinkInstallation';

const c = enMessages.onboardingMigrate.connect;
const o = c.existing.outcome;
const RUN = 'run-1';
const ORG = 'org-1';
const ACCOUNTS_URL = `/api/organizations/${ORG}/github/accounts`;
const LINK_URL = `/api/organizations/${ORG}/github/installations`;

function connectState(outcome: MigrateConnectOutcome): MigrateConnectStateDto {
  const usable = outcome === 'connected';
  return {
    organizationId: ORG,
    installation: {
      bound: usable,
      accounts: usable
        ? [{ installationRef: '101', accountLogin: 'acme-labs', accountType: 'Organization' }]
        : [],
    },
    repositories: usable
      ? [{ provider: 'github', repoRef: 'acme-labs/web', defaultBranch: 'main' }]
      : [],
    outcome,
    snapshot: 'mcs1.cnVuLTE',
  };
}

const ACME: GithubAccountForOrganizationDTO = {
  installationId: '101',
  accountLogin: 'acme-labs',
  accountType: 'Organization',
  avatarUrl: null,
  visibleRepoCount: 4,
  linkState: 'linked_here',
};
const DANA: GithubAccountForOrganizationDTO = {
  installationId: '202',
  accountLogin: 'dana-okafor',
  accountType: 'User',
  avatarUrl: null,
  visibleRepoCount: 1,
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

const BEFORE = repos([
  { repoId: '1', fullName: 'acme-labs/web', availability: 'available' },
  { repoId: '2', fullName: 'acme-labs/api', availability: 'available' },
  { repoId: '3', fullName: 'acme-labs/docs', availability: 'connected_here' },
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Answer = { status: number; body: unknown } | 'network';

interface Fakes {
  link: Answer[];
  repoAnswers?: unknown[];
  connect?: MigrateConnectStateDto[];
}

/** Fakes every read and the link write; each list is consumed in order, the
 *  last answer repeating. Returns the spy and the link bodies posted. */
function fake({ link, repoAnswers = [BEFORE], connect = [connectState('not_started')] }: Fakes) {
  const links = [...link];
  const repoQueue = [...repoAnswers];
  const connectQueue = [...connect];
  const posted: unknown[] = [];
  const take = <T,>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]!);
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`/api/onboarding/migrate/${RUN}/connect-state`))
      return json(take(connectQueue));
    if (url === ACCOUNTS_URL) return json({ state: 'ok', accounts: [ACME, DANA] });
    if (url.endsWith('/repositories')) return json(take(repoQueue));
    if (url === LINK_URL && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      const next = take(links);
      if (next === 'network') throw new TypeError('offline');
      return json(next.body, next.status);
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', spy);
  return { spy, posted };
}

function renderStep() {
  const onAdvance = vi.fn(async (): Promise<ConnectAdvanceResult> => ({ kind: 'ok' }));
  return renderWithIntl(<ConnectPanel runId={RUN} onAdvance={onAdvance} busy={false} />);
}

async function flush() {
  await act(async () => {});
  await act(async () => {});
}

async function openAcmeAndChoose(...names: string[]) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose repositories from acme-labs' }));
  });
  await flush();
  for (const name of names) fireEvent.click(within(rowOf(name)).getByRole('checkbox'));
}

const rowOf = (name: string) =>
  screen
    .getAllByTestId('existing-picker-row')
    .find((r) => r.textContent?.includes(name)) as HTMLElement;

async function confirm() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('existing-picker-confirm'));
  });
  await flush();
}

beforeEach(() => {
  query.current = new URLSearchParams();
  window.history.replaceState(null, '', '/onboarding/migrate');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('linked (2s.i)', () => {
  it('posts the organisation’s set once, closes the picker, re-reads, and Continue appears under the outcome', async () => {
    const { spy, posted } = fake({
      link: [{ status: 200, body: { installation: {}, claimed: ['1'], released: [] } }],
      connect: [connectState('not_started'), connectState('connected')],
    });
    renderStep();
    await openAcmeAndChoose('web');
    const before = spy.mock.calls.filter(([u]) => String(u).includes('/connect-state')).length;
    await confirm();

    // The chosen repository, with the one already connected here kept: the
    // link REPLACES this organisation's set on the account.
    expect(posted).toEqual([{ installationId: '101', repoIds: ['3', '1'] }]);
    expect(screen.queryByTestId('existing-repository-picker')).toBeNull();
    expect(spy.mock.calls.filter(([u]) => String(u).includes('/connect-state')).length).toBe(
      before + 1,
    );
    const region = screen.getByTestId('connect-state-connected');
    const outcome = within(region).getByTestId('link-outcome-linked');
    expect(within(outcome).getByText(o.linkedTitle)).toBeTruthy();
    expect(within(outcome).getByText(o.linkedHint)).toBeTruthy();
    const summary = within(region).getByText('1 repository is connected');
    expect(
      outcome.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
  });

  it('a not-yet-linked account posts exactly the chosen ids', async () => {
    const { posted } = fake({
      link: [{ status: 200, body: {} }],
      repoAnswers: [
        repos([
          { repoId: '7', fullName: 'dana-okafor/site', availability: 'available' },
          { repoId: '8', fullName: 'dana-okafor/notes', availability: 'available' },
        ]),
      ],
    });
    renderStep();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose repositories from dana-okafor' }));
    });
    await flush();
    fireEvent.click(within(rowOf('site')).getByRole('checkbox'));
    await confirm();
    expect(posted).toEqual([{ installationId: '202', repoIds: ['7'] }]);
  });

  it('is loading while the write is out, and a second press does not post again', async () => {
    let release: (r: Response) => void = () => {};
    const posted: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === LINK_URL) {
          posted.push(init?.body);
          return new Promise<Response>((r) => (release = r));
        }
        if (url === ACCOUNTS_URL) return json({ state: 'ok', accounts: [ACME] });
        if (url.endsWith('/repositories')) return json(BEFORE);
        return json(connectState('not_started'));
      }),
    );
    renderStep();
    await openAcmeAndChoose('web');
    const button = screen.getByTestId('existing-picker-confirm') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(posted).toHaveLength(1);
    await act(async () => {
      release(json({}, 500));
    });
    await flush();
  });
});

describe('taken meanwhile (2s.ii, 409)', () => {
  it('names the repository, marks it in place, keeps the rest of the choice, and stays submittable', async () => {
    const { container, posted } = (() => {
      const f = fake({
        link: [
          {
            status: 409,
            body: {
              code: 'repository_owned_by_other_organization',
              repos: [{ repoId: '1', fullName: 'acme-labs/web' }],
            },
          },
          { status: 200, body: {} },
        ],
        repoAnswers: [
          BEFORE,
          repos([
            { repoId: '1', fullName: 'acme-labs/web', availability: 'connected_elsewhere' },
            { repoId: '2', fullName: 'acme-labs/api', availability: 'available' },
            { repoId: '3', fullName: 'acme-labs/docs', availability: 'connected_here' },
          ]),
        ],
      });
      return { ...renderStep(), posted: f.posted };
    })();
    await openAcmeAndChoose('web', 'api');
    await confirm();

    const outcome = screen.getByTestId('link-outcome-taken');
    expect(within(outcome).getByText(o.takenTitle)).toBeTruthy();
    expect(
      within(outcome).getByText(
        'Another organisation connected acme-labs/web. Nothing was connected. The list is updated, so choose again.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('existing-repository-picker')).toBeTruthy();
    expect(rowOf('web').getAttribute('data-availability')).toBe('connected_elsewhere');
    expect(rowOf('web').getAttribute('data-taken')).toBe('true');
    expect(within(rowOf('api')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    const button = screen.getByTestId('existing-picker-confirm') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[data-tone="danger"]')).toBeNull();

    await confirm();
    expect(posted.at(-1)).toEqual({ installationId: '101', repoIds: ['3', '2'] });
  });
});

describe('no longer accessible (2s.v, 403 installation_not_accessible)', () => {
  it('drops the account from the list, closes the picker, and offers the install row', async () => {
    fake({ link: [{ status: 403, body: { code: 'installation_not_accessible' } }] });
    renderStep();
    await openAcmeAndChoose('web');
    await confirm();
    expect(screen.queryByTestId('existing-repository-picker')).toBeNull();
    const outcome = screen.getByTestId('link-outcome-not-accessible');
    expect(within(outcome).getByText(o.notAccessibleTitle)).toBeTruthy();
    expect(within(outcome).getByText(o.notAccessibleHint)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose repositories from acme-labs' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Choose repositories from dana-okafor' }),
    ).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(c.existing.installAnotherCta);
  });
});

describe('not an admin (2s.vii, 403 ORG_FORBIDDEN)', () => {
  it('replaces the list and the picker with the sentence; the install row stays', async () => {
    fake({ link: [{ status: 403, body: { code: 'ORG_FORBIDDEN', error: 'no' } }] });
    renderStep();
    await openAcmeAndChoose('web');
    await confirm();
    expect(screen.queryByTestId('existing-repository-picker')).toBeNull();
    expect(screen.queryByTestId('existing-accounts')).toBeNull();
    const outcome = screen.getByTestId('link-outcome-not-admin');
    expect(within(outcome).getByText(o.notAdminTitle)).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(c.existing.installAnotherCta);
  });
});

describe('the two 422s (2s.iii, 2s.iv)', () => {
  it('repo_selection_required keeps the picker open with its outcome', async () => {
    fake({ link: [{ status: 422, body: { code: 'repo_selection_required' } }] });
    renderStep();
    await openAcmeAndChoose('web');
    await confirm();
    const outcome = screen.getByTestId('link-outcome-selection-required');
    expect(within(outcome).getByText(o.selectionRequiredHint)).toBeTruthy();
    expect(screen.getByTestId('existing-repository-picker')).toBeTruthy();
  });

  it('repository_not_visible re-reads the list in place and keeps the remaining choice', async () => {
    const { spy } = fake({
      link: [{ status: 422, body: { code: 'repository_not_visible', repoIds: ['1'] } }],
      repoAnswers: [
        BEFORE,
        repos([
          { repoId: '2', fullName: 'acme-labs/api', availability: 'available' },
          { repoId: '3', fullName: 'acme-labs/docs', availability: 'connected_here' },
        ]),
      ],
    });
    renderStep();
    await openAcmeAndChoose('web', 'api');
    const reads = () => spy.mock.calls.filter(([u]) => String(u).endsWith('/repositories')).length;
    const before = reads();
    await confirm();
    expect(reads()).toBe(before + 1);
    const outcome = screen.getByTestId('link-outcome-not-visible');
    expect(within(outcome).getByText(o.notVisibleTitle)).toBeTruthy();
    expect(screen.queryByText('web', { exact: false })).toBeNull();
    expect(within(rowOf('api')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  });
});

describe('anything else', () => {
  it.each([
    ['a 5xx', { status: 502, body: {} } as Answer],
    ['an unknown code', { status: 409, body: { code: 'something_new' } } as Answer],
    ['a network error', 'network' as Answer],
  ])(
    '%s shows the load-error block with retry, keeps the choice, and never says linked',
    async (_label, answer) => {
      const { posted } = fake({ link: [answer, { status: 200, body: {} }] });
      renderStep();
      await openAcmeAndChoose('web');
      await confirm();
      const outcome = screen.getByTestId('link-outcome-failed');
      expect(within(outcome).getByText(c.existing.loadErrorTitle)).toBeTruthy();
      expect(screen.queryByTestId('link-outcome-linked')).toBeNull();
      expect(within(rowOf('web')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
      await act(async () => {
        fireEvent.click(within(outcome).getByRole('button', { name: c.existing.retryCta }));
      });
      await flush();
      expect(posted).toHaveLength(2);
      expect(posted[1]).toEqual(posted[0]);
    },
  );
});

describe('the wire shape', () => {
  it('tells the two 403s apart by the body code', async () => {
    expect(await linkResultFrom(json({ code: 'installation_not_accessible' }, 403))).toEqual({
      kind: 'not_accessible',
    });
    expect(await linkResultFrom(json({ code: 'ORG_FORBIDDEN' }, 403))).toEqual({
      kind: 'not_admin',
    });
    expect(await linkResultFrom(json({ code: 'NOT_A_MEMBER' }, 403))).toEqual({ kind: 'failed' });
  });
});
