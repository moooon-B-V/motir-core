// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import {
  GITHUB_BANNER_STATUSES,
  GITHUB_BANNER_TONE,
  GITHUB_BENIGN_BANNER_STATUSES,
} from '@/lib/github/bannerStatus';
import type { MigrateConnectOutcome, MigrateConnectStateDto } from '@/lib/dto/migrateOnboarding';

// MOTIR-8475 — the connect step: the pre-flight, one action per outcome state,
// and no control that does nothing (`design/onboarding-migrate/` Revision 7,
// panels 2a–2k). The two producers are faked at their boundaries: the connect
// read at `fetch`, the round trip's report at the address (`?github=`). What
// they compute is `tests/migrate-onboarding/` and `tests/github/`'s to prove.

const query: { current: URLSearchParams } = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => query.current,
  usePathname: () => '/onboarding/migrate',
}));

import {
  ConnectPanel,
  connectBeforeStorageKey,
  connectReportFrom,
  connectStepState,
  type ConnectAdvanceResult,
} from '@/app/(onboarding)/onboarding/migrate/_components/ConnectPanel';

const c = enMessages.onboardingMigrate.connect;
const RUN = 'run-1';
const SNAPSHOT = 'mcs1.cnVuLTE';

function makeState(
  outcome: MigrateConnectOutcome,
  overrides: Partial<MigrateConnectStateDto> = {},
): MigrateConnectStateDto {
  const usable = outcome === 'connected' || outcome === 'already_connected';
  const bound = usable || outcome === 'no_repositories_selected';
  return {
    organizationId: 'org-1',
    installation: {
      bound,
      accounts: bound
        ? [{ installationRef: '4242', accountLogin: 'acme', accountType: 'Organization' }]
        : [],
    },
    repositories: usable
      ? [
          { provider: 'github', repoRef: 'acme/web', defaultBranch: 'main' },
          { provider: 'github', repoRef: 'acme/api', defaultBranch: 'main' },
        ]
      : [],
    outcome,
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fakes the connect read. `answers` is consumed in order; the last repeats. */
function fakeRead(...answers: Array<MigrateConnectStateDto | number>) {
  const queue = [...answers];
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // The accounts read (MOTIR-8762) answers NO installed account, so the step
    // is the shipped one these cases describe (Revision 8, 2n);
    // `onboarding-existing-accounts.test.tsx` drives every other answer.
    if (url.includes('/github/accounts')) return json({ state: 'ok', accounts: [] });
    if (!url.startsWith(`/api/onboarding/migrate/${RUN}/connect-state`)) return json({}, 404);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof next === 'number' ? json({ code: 'boom' }, next) : json(next);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The connect reads among a spy's calls — the accounts read is not one. */
const connectReads = (spy: ReturnType<typeof fakeRead>) =>
  spy.mock.calls.filter(([input]) => String(input).includes('/connect-state'));

function arriveAt(search: string) {
  window.history.replaceState(null, '', `/onboarding/migrate${search}`);
  query.current = new URLSearchParams(search);
}

function renderStep(
  onAdvance = vi.fn(async (): Promise<ConnectAdvanceResult> => ({ kind: 'ok' })),
) {
  const view = renderWithIntl(<ConnectPanel runId={RUN} onAdvance={onAdvance} busy={false} />);
  return { ...view, onAdvance };
}

/** Flush the deferred first read (a 0 ms timer) and its response. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
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

describe('arriving with nothing bound — the pre-flight (2b)', () => {
  it('says what GitHub will ask, with ONE primary Connect GitHub and no settings link', async () => {
    fakeRead(makeState('not_started'));
    const { container } = renderStep();
    await settle();

    const region = screen.getByTestId('connect-state-preflight');
    const preflight = within(region).getByTestId('connect-preflight');
    for (const line of [
      c.preflightAccount,
      c.preflightRepositories,
      c.preflightAccess,
      c.preflightReturn,
    ]) {
      expect(within(preflight).getByText(line)).toBeTruthy();
    }
    const start = screen.getByTestId('connect-start');
    expect(start.textContent).toContain(c.preflightCta);
    expect(screen.getAllByTestId('connect-start')).toHaveLength(1);
    expect(container.querySelector('a[href*="/settings/organization/git"]')).toBeNull();
    expect(screen.queryByTestId('connect-continue')).toBeNull();
  });
});

describe('pressing Connect GitHub (2e → 2c)', () => {
  it('enters starting, stores the before token for this run, and opens the install start with the step’s query', async () => {
    arriveAt('?via=onboard_existing_project&steps=connect,index');
    const fetchSpy = fakeRead(makeState('not_started'));
    const tab = { opener: {} as unknown };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderStep();
    await settle();

    fireEvent.click(screen.getByTestId('connect-start'));

    // Starting: the control is loading, the pre-flight is still readable.
    expect(screen.getByTestId('connect-state-starting')).toBeTruthy();
    const start = screen.getByTestId('connect-start');
    expect(start.getAttribute('aria-busy')).toBe('true');
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(start.textContent).toContain(c.starting);
    expect(screen.getByTestId('connect-preflight')).toBeTruthy();

    expect(window.sessionStorage.getItem(connectBeforeStorageKey(RUN))).toBe(SNAPSHOT);
    expect(open).toHaveBeenCalledTimes(1);
    const [href, target] = open.mock.calls[0]!;
    expect(target).toBe('_blank');
    const url = new URL(String(href), 'http://localhost');
    expect(url.pathname).toBe('/api/github/install/start');
    expect(url.searchParams.get('via')).toBe('onboard_existing_project');
    expect(url.searchParams.get('steps')).toBe('connect,index');
    // The opener handle is cut once the tab exists.
    expect(tab.opener).toBeNull();

    // The browser leaves: the step waits on the other tab, with a SECONDARY
    // way back to GitHub — never a dead primary.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    const waiting = screen.getByTestId('connect-state-waiting');
    expect(within(waiting).getByText(c.waitingTitle)).toBeTruthy();
    expect(screen.queryByTestId('connect-start')).toBeNull();
    expect(within(waiting).getByRole('button', { name: new RegExp(c.reopenCta) })).toBeTruthy();

    // Every later read echoes the token, so the read can witness the departure.
    fetchSpy.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `/api/onboarding/migrate/${RUN}/connect-state?before=${encodeURIComponent(SNAPSHOT)}`,
    );
  });

  it('a blocked popup leaves in this tab instead of doing nothing', async () => {
    fakeRead(makeState('not_started'));
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    const realLocation = window.location;
    vi.stubGlobal('location', { ...realLocation, search: '', assign });
    renderStep();
    await settle();

    fireEvent.click(screen.getByTestId('connect-start'));
    expect(assign).toHaveBeenCalledWith('/api/github/install/start');
    expect(screen.getByTestId('connect-state-starting')).toBeTruthy();
  });

  it('a fresh load of the return address echoes the stored token', async () => {
    window.sessionStorage.setItem(connectBeforeStorageKey(RUN), SNAPSHOT);
    arriveAt('?github=installed&installation_id=4242');
    const fetchSpy = fakeRead(makeState('connected'));
    renderStep();
    await settle();
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(`?before=${encodeURIComponent(SNAPSHOT)}`);
    // `installed` defers to the read, which alone knows repositories exist.
    expect(screen.getByTestId('connect-state-connected')).toBeTruthy();
  });

  it('storage that throws is treated as absent (the read answers not_started)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const fetchSpy = fakeRead(makeState('not_started'));
    renderStep();
    await settle();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`/api/onboarding/migrate/${RUN}/connect-state`);
    expect(screen.getByTestId('connect-state-preflight')).toBeTruthy();
  });
});

describe('the round trip’s report outranks the read', () => {
  it('install_requested → owner_pending, no primary, a secondary way back to GitHub, never danger — though the read says not_started', async () => {
    arriveAt('?github=install_requested');
    fakeRead(makeState('not_started'));
    renderStep();
    await settle();

    const region = screen.getByTestId('connect-state-owner_pending');
    expect(within(region).getByText(c.ownerPendingTitle)).toBeTruthy();
    expect(
      within(region)
        .getByText(c.pill.ownerPending)
        .closest('[data-tone]')!
        .getAttribute('data-tone'),
    ).toBe('info');
    expect(screen.queryByTestId('connect-start')).toBeNull();
    expect(screen.queryByTestId('connect-continue')).toBeNull();
    const back = within(region).getByRole('button', { name: new RegExp(c.ownerPendingOpenCta) });
    expect(back.getAttribute('data-variant')).toBe('secondary');
  });

  const FAILED: Array<{
    status: keyof typeof c.outcome extends never ? never : string;
    action: string;
  }> = [
    { status: 'install_expired', action: c.preflightCta },
    { status: 'install_forbidden', action: c.preflightCta },
    { status: 'install_provider_error', action: c.tryAgainCta },
    { status: 'install_error', action: c.preflightCta },
    { status: 'installation_not_accessible', action: c.preflightCta },
  ];

  for (const { status, action } of FAILED) {
    it(`${status} → failed, in its own tone (${GITHUB_BANNER_TONE[status as keyof typeof GITHUB_BANNER_TONE]}), with its own way forward`, async () => {
      arriveAt(`?github=${status}`);
      fakeRead(makeState('not_started'));
      renderStep();
      await settle();

      const region = screen.getByTestId('connect-state-failed');
      const outcome = c.outcome as Record<string, string>;
      expect(within(region).getByText(outcome[`${status}Title`]!)).toBeTruthy();
      expect(within(region).getByText(outcome[`${status}Hint`]!)).toBeTruthy();
      const tone = region.querySelector('[data-tone]')!.getAttribute('data-tone');
      expect(tone).toBe(GITHUB_BANNER_TONE[status as keyof typeof GITHUB_BANNER_TONE]);
      const start = screen.getByTestId('connect-start');
      expect(start.textContent).toContain(action);
      expect(screen.queryByTestId('connect-continue')).toBeNull();
    });
  }

  it('repo_unavailable’s way forward is the selection on GitHub, never Motir’s settings', async () => {
    arriveAt('?github=repo_unavailable');
    fakeRead(makeState('no_repositories_selected'));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-failed');
    const link = within(region).getByRole('link', { name: new RegExp(c.changeReposCta) });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/organizations/acme/settings/installations/4242',
    );
  });

  it('not_configured → failed with nothing to press (another press would land right back)', async () => {
    arriveAt('?github=not_configured');
    fakeRead(makeState('not_started'));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-failed');
    expect(within(region).getByText(c.outcome.not_configuredTitle)).toBeTruthy();
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
  });

  it('install_unbound (a deny on GitHub) → the cancelled panel, benign', async () => {
    arriveAt('?github=install_unbound');
    fakeRead(makeState('not_started'));
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-install_cancelled')).toBeTruthy();
  });

  it('expired, owner-approval and cancelled are never drawn in the danger tone', async () => {
    for (const status of ['install_expired', 'install_requested', 'install_unbound']) {
      arriveAt(`?github=${status}`);
      fakeRead(makeState('install_cancelled'));
      const { unmount, container } = renderStep();
      await settle();
      expect(container.querySelector('[data-tone="danger"]'), status).toBeNull();
      unmount();
    }
  });

  it('a report never hides a Continue the gate would pass (an owner approved meanwhile)', async () => {
    arriveAt('?github=install_requested');
    fakeRead(makeState('connected'));
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-connected')).toBeTruthy();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
  });
});

describe('with no report, the read’s outcome renders one to one', () => {
  it('connected → the list, Continue, and manage on GITHUB (F1)', async () => {
    fakeRead(makeState('connected'));
    const { container } = renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-connected');
    expect(within(region).getByText('2 repositories are connected')).toBeTruthy();
    expect(
      within(region).getByText(c.pill.connected).closest('[data-tone]')!.getAttribute('data-tone'),
    ).toBe('success');
    const list = within(region).getByRole('list', { name: c.listLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByText(c.providerGithub)).toHaveLength(2);
    const manage = screen.getByRole('link', { name: new RegExp(c.manage) });
    expect(manage.getAttribute('href')).toBe(
      'https://github.com/organizations/acme/settings/installations/4242',
    );
    expect(container.querySelector('a[href*="/settings/organization/git"]')).toBeNull();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
    expect(screen.queryByTestId('connect-start')).toBeNull();
  });

  it('already_connected → Continue, add more on GitHub, and no install as the primary', async () => {
    fakeRead(makeState('already_connected'));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-already_connected');
    expect(within(region).getByText(c.alreadyConnectedTitle)).toBeTruthy();
    expect(within(region).getByText(c.pill.alreadyConnected)).toBeTruthy();
    expect(screen.getByRole('link', { name: new RegExp(c.alreadyConnectedAddMore) })).toBeTruthy();
    expect(screen.getByTestId('connect-continue')).toBeTruthy();
    expect(screen.queryByTestId('connect-start')).toBeNull();
  });

  it('no_repositories_selected → change the selection on GitHub, info tone, no Continue', async () => {
    fakeRead(makeState('no_repositories_selected'));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-no_repositories_selected');
    expect(within(region).getByText(c.noReposTitle)).toBeTruthy();
    expect(region.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('info');
    const link = within(region).getByRole('link', { name: new RegExp(c.changeReposCta) });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/organizations/acme/settings/installations/4242',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByTestId('connect-continue')).toBeNull();
  });

  it('install_cancelled → benign (no tone chip), with the pre-flight and Connect GitHub to try again', async () => {
    fakeRead(makeState('install_cancelled'));
    const { container } = renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-install_cancelled');
    expect(within(region).getByText(c.cancelledTitle)).toBeTruthy();
    expect(container.querySelector('[data-tone]')).toBeNull();
    expect(within(region).getByTestId('connect-preflight')).toBeTruthy();
    expect(screen.getByTestId('connect-start').textContent).toContain(c.preflightCta);
    expect(screen.queryByTestId('connect-continue')).toBeNull();
  });

  it('not_started → the pre-flight', async () => {
    fakeRead(makeState('not_started'));
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-preflight')).toBeTruthy();
  });
});

describe('the report is not replayed', () => {
  it('drops github (and installation_id) from the address once rendered; a reload renders from the read alone', async () => {
    arriveAt('?via=onboard_existing_project&github=install_requested&installation_id=4242');
    fakeRead(makeState('not_started'));
    const first = renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-owner_pending')).toBeTruthy();
    expect(window.location.search).toBe('?via=onboard_existing_project');

    // Reload: the address no longer carries the report.
    first.unmount();
    query.current = new URLSearchParams(window.location.search);
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-preflight')).toBeTruthy();
  });
});

describe('a failed read (2k)', () => {
  it('shows read_failed with a retry that re-reads', async () => {
    const fetchSpy = fakeRead(500, makeState('not_started'));
    renderStep();
    await settle();
    const region = screen.getByTestId('connect-state-read_failed');
    expect(within(region).getByText(c.readFailedTitle)).toBeTruthy();
    expect(connectReads(fetchSpy)).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-retry'));
    });
    await act(async () => {});
    expect(connectReads(fetchSpy)).toHaveLength(2);
    expect(screen.getByTestId('connect-state-preflight')).toBeTruthy();
  });

  it('does not silently keep the previous state', async () => {
    fakeRead(makeState('connected'), 503);
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-connected')).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {});
    expect(screen.getByTestId('connect-state-read_failed')).toBeTruthy();
    expect(screen.queryByTestId('connect-continue')).toBeNull();
  });

  it('a network failure is a failed read too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    renderStep();
    await settle();
    expect(screen.getByTestId('connect-state-read_failed')).toBeTruthy();
  });
});

describe('Continue', () => {
  it('calls the shipped advance', async () => {
    fakeRead(makeState('already_connected'));
    const { onAdvance } = renderStep();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-continue'));
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('a conflict answer re-reads rather than leaving a dead button', async () => {
    const fetchSpy = fakeRead(makeState('connected'));
    const onAdvance = vi.fn(async (): Promise<ConnectAdvanceResult> => ({ kind: 'conflict' }));
    renderStep(onAdvance);
    await settle();
    expect(connectReads(fetchSpy)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-continue'));
    });
    await act(async () => {});
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(connectReads(fetchSpy)).toHaveLength(2);
  });

  it('is rendered in connected and already_connected ONLY', () => {
    // Every state the read can produce, plus every report: the precedence
    // function decides the state, and only the two connected ones carry it.
    const outcomes: MigrateConnectOutcome[] = [
      'already_connected',
      'connected',
      'no_repositories_selected',
      'install_cancelled',
      'not_started',
    ];
    const withContinue = new Set<string>();
    for (const outcome of outcomes) {
      for (const raw of [null, ...GITHUB_BANNER_STATUSES]) {
        for (const phase of ['idle', 'waiting'] as const) {
          const state = connectStepState({
            hasRun: true,
            read: makeState(outcome),
            readFailed: false,
            phase,
            report: connectReportFrom(raw),
          });
          if (state === 'connected' || state === 'already_connected') withContinue.add(outcome);
        }
      }
    }
    expect([...withContinue].sort()).toEqual(['already_connected', 'connected']);
  });
});

describe('the precedence, as a table', () => {
  it('maps every banner status to a report, a deferral or nothing — and benign ones never to danger', () => {
    for (const status of GITHUB_BANNER_STATUSES) {
      const report = connectReportFrom(status);
      if (
        report?.kind === 'failed' &&
        (GITHUB_BENIGN_BANNER_STATUSES as readonly string[]).includes(status)
      ) {
        expect(GITHUB_BANNER_TONE[status], status).not.toBe('danger');
      }
    }
    expect(connectReportFrom('install_requested')).toEqual({ kind: 'owner_pending' });
    expect(connectReportFrom('installed')).toBeNull();
    expect(connectReportFrom('repos_updated')).toBeNull();
    expect(connectReportFrom('select_repos')).toBeNull();
    expect(connectReportFrom('whatever')).toBeNull();
    expect(connectReportFrom('__proto__')).toBeNull();
    expect(connectReportFrom(null)).toBeNull();
  });

  it('no run → checking; a press → starting even over a failed read; waiting holds until something lands', () => {
    const base = { read: makeState('not_started'), readFailed: false, report: null };
    expect(connectStepState({ ...base, hasRun: false, phase: 'idle' })).toBe('checking');
    expect(connectStepState({ ...base, hasRun: true, read: null, phase: 'idle' })).toBe('checking');
    expect(connectStepState({ ...base, hasRun: true, readFailed: true, phase: 'starting' })).toBe(
      'starting',
    );
    expect(connectStepState({ ...base, hasRun: true, phase: 'waiting' })).toBe('waiting');
    expect(
      connectStepState({
        ...base,
        hasRun: true,
        read: makeState('install_cancelled'),
        phase: 'waiting',
      }),
    ).toBe('waiting');
    expect(
      connectStepState({
        ...base,
        hasRun: true,
        read: makeState('no_repositories_selected'),
        phase: 'waiting',
      }),
    ).toBe('no_repositories_selected');
  });
});

describe('waiting (2c) — the return to this tab decides a cancel, a poll never does', () => {
  it('a poll answering install_cancelled keeps waiting; coming back to the tab shows the cancel', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      fakeRead(makeState('not_started'), makeState('install_cancelled'));
      vi.spyOn(window, 'open').mockReturnValue({ opener: null } as unknown as Window);
      renderStep();
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      await act(async () => {});
      fireEvent.click(screen.getByTestId('connect-start'));
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(screen.getByTestId('connect-state-waiting')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await act(async () => {});
      expect(screen.getByTestId('connect-state-waiting')).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await act(async () => {});
      expect(screen.getByTestId('connect-state-install_cancelled')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
