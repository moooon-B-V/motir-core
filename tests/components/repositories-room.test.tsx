// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import type {
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
  ProjectRepoTakeoverDto,
} from '@/lib/dto/projectRepos';

// THE TAKE-IT-OVER SURFACE (Story MOTIR-1775 · MOTIR-1939 —
// design/repository-set §14), at the altitude where its claims are actually
// falsifiable.
//
// What is pinned here is every property the card would be WRONG without, and
// each is asserted as a behaviour rather than as a class name:
//
//   1. The per-row action appears ONLY on a Motir-owned row; a connect-existing
//      row is the already-yours no-op with NO action. Asserted per row, because
//      the bug is a control leaking onto the wrong one.
//   2. `transfer_pending` / `awaiting_reinstall` are DURABLE, RE-PROMPTABLE
//      states — a place with something to go do, never a spinner. Asserted by
//      the presence of the re-prompt and the ABSENCE of any progressbar.
//   3. Taking over one row of three leaves the others rendering AND pressable
//      (MOTIR-711's per-row rule — the property most easily lost).
//   4. The page-state contract: the mutation's returned row is applied LOCALLY
//      (never re-read — a refresh there causes the visible revert) AND
//      `router.refresh()` is called for the server-rendered header. Both, or the
//      surface is half-updated.
//   5. The picker degrades: its loading and unavailable states are real, and the
//      PERSONAL account is selectable through both.
//   6. No identity → MOTIR-1900's connect prompt, not a failure and not a second
//      prompt of this flow's own.
//   7. The costs are stated before the commit, and nothing says "one click".
//
// The ONLY fakes are `fetch` (the wire) and `useRouter` (the framework boundary)
// — the same line every component suite in this repo fakes at.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const NOW = '2026-07-31T12:00:00.000Z';
/** Comfortably past the 3-day staleness threshold, so the "days later" copy is
 *  exercised by a date rather than by reaching into the component. */
const LONG_AGO = '2026-07-20T12:00:00.000Z';

let fetchMock: ReturnType<typeof vi.fn>;
/** What the SET read answers with — the rows currently rendered, so a re-read
 *  reflects reality instead of emptying the room out from under the test. */
let currentRows: ProjectRepoDto[] = [];

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async (url: string) => jsonOk(defaultFetch(String(url))));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the room — which rows offer a move (design §14, panel 1)', () => {
  it('offers the move on a Motir-owned row and NOTHING on an already-yours row', async () => {
    renderRoom({ rows: [hostedRow(), connectedRow()] });

    const hosted = screen.getByTestId('takeover-row-web');
    const yours = screen.getByTestId('takeover-row-shared');

    expect(within(hosted).getByText('Created')).toBeTruthy();
    expect(
      within(hosted).getByRole('button', {
        name: 'Move motir-projects/acme-booking-web to my GitHub',
      }),
    ).toBeTruthy();

    // The already-yours no-op: the state word, the reassurance, and no control.
    expect(within(yours).getByText('Yours')).toBeTruthy();
    expect(
      within(yours).getByText(
        'You already own this one — nothing to move, and Motir never bills its CI.',
      ),
    ).toBeTruthy();
    expect(within(yours).queryByRole('button')).toBeNull();
  });

  it('renders the empty room rather than an empty list when the project has no repositories', () => {
    renderRoom({ rows: [] });
    expect(
      screen.getByText(
        'This project has no repositories yet. Motir sets them up when you approve a plan, and they appear here.',
      ),
    ).toBeTruthy();
  });
});

describe('the waiting states are places, not spinners (panels 4, 5, 7)', () => {
  it('renders transfer_pending as a durable, re-promptable row with somewhere to go', () => {
    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })] });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Waiting for you to accept on GitHub')).toBeTruthy();
    expect(within(row).getByRole('status')).toBeTruthy();
    // The re-prompt AND the way out — the two things that make an abandoned
    // hand-off recoverable rather than wedged.
    expect(
      within(row).getByRole('link', {
        name: 'Accept motir-projects/acme-booking-web on GitHub',
      }),
    ).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Check motir-projects/acme-booking-web again' }),
    ).toBeTruthy();
    // NOT a spinner: an unbounded wait on a human must never be drawn as progress.
    expect(within(row).queryByRole('progressbar')).toBeNull();
  });

  it('renders awaiting_reinstall with the install hand-off AND the dispatch consequence', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'awaiting_reinstall', transferredAt: NOW }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Install Motir on yue-personal')).toBeTruthy();
    // The CONSEQUENCE, not just the chore — and as an alert, because dispatch
    // being off is the thing the user did not ask for.
    expect(within(row).getByRole('alert').textContent).toContain(
      "Motir can't dispatch work to this repository",
    );
    const install = within(row).getByRole('link', {
      name: 'Install Motir for motir-projects/acme-booking-web on GitHub',
    });
    // The SHIPPED install screen — never a faked in-app repository picker.
    expect(install.getAttribute('href')).toBe('https://github.com/apps/motir/installations/new');
  });

  it('says so when a wait has been sitting for days, and still does not call it an error', () => {
    renderRoom({
      rows: [
        hostedRow({ takeover: takeover({ state: 'transfer_pending', requestedAt: LONG_AGO }) }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Still waiting for you to accept on GitHub')).toBeTruthy();
    expect(within(row).getByText(/Nothing is wrong and nothing was lost/)).toBeTruthy();
    // An unaccepted transfer is NOT a failure and is never tinted as one.
    expect(within(row).queryByText("Couldn't move it")).toBeNull();
  });

  it('drops the install button rather than linking nowhere when no App slug is configured', () => {
    renderRoom({
      rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })],
      installHref: null,
    });
    expect(screen.queryByRole('link', { name: /Install Motir for/ })).toBeNull();
    // The re-prompt survives — the row still is not a dead end.
    expect(screen.getByRole('button', { name: /Check .* again/ })).toBeTruthy();
  });
});

describe('done and failed (panels 6, 7)', () => {
  it('settles into the same shape a brought-in repository has, plus who pays now', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'done', transferredAt: NOW, completedAt: NOW }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');
    expect(within(row).getByText('Yours')).toBeTruthy();
    expect(within(row).getByText(/GitHub bills you for Actions on it from now on/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Move .* to my GitHub/ })).toBeNull();
  });

  it('explains an ORG refusal in the user’s own language AND keeps GitHub’s real reason', async () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({
            state: 'failed',
            targetOwner: 'acme-inc',
            failureReason: 'GitHub refused the transfer (HTTP 403).',
          }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText("Couldn't move it")).toBeTruthy();
    expect(within(row).getByRole('alert').textContent).toContain(
      'you need permission to create repositories in that organization',
    );
    expect(within(row).getByText('GitHub refused the transfer (HTTP 403).')).toBeTruthy();
    // Both recoveries — no state is a dead end.
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Pick a different account' })).toBeTruthy();
  });

  it('shows only the recorded reason when the target was the user’s own account', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'failed', failureReason: 'GitHub was unreachable.' }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');
    expect(within(row).getByText('GitHub was unreachable.')).toBeTruthy();
    expect(within(row).queryByText(/permission to create repositories/)).toBeNull();
  });
});

describe('the decision modal (panels 2–3)', () => {
  it('offers the personal account first, then the organizations, with the choice checked', async () => {
    renderRoom({ rows: [hostedRow()] });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    const personal = await screen.findByRole('option', { name: /yue-personal/ });
    expect(personal.getAttribute('aria-selected')).toBe('true');

    const org = await screen.findByRole('option', { name: /acme-inc/ });
    expect(org.getAttribute('aria-selected')).toBe('false');

    // The org price, stated ONCE under the list — never used to hide the option.
    expect(screen.getByText(/needs permission to create repositories there/)).toBeTruthy();

    await click(org);
    expect(
      (await screen.findByRole('option', { name: /acme-inc/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('renders the org lookup as a real loading state, with the personal account already usable', async () => {
    // A lookup that never resolves — the loading state is a STATE, not a frame
    // between two renders, so it has to hold on its own.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/github/organizations')
        ? new Promise(() => {})
        : jsonOk(defaultFetch(String(url))),
    );
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(await screen.findByText('Looking up your organizations…')).toBeTruthy();
    expect(
      screen.getByText(
        'You can go ahead with your personal account — the lookup only adds organizations.',
      ),
    ).toBeTruthy();
    // The whole point of the degradation: the personal option is present from
    // first paint, so focus is never trapped in an empty listbox.
    expect(screen.getByRole('option', { name: /yue-personal/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false);
  });

  it('degrades — not blocks — when the org lookup fails, and can be retried', async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/github/organizations')) {
        attempts += 1;
        if (attempts === 1) return new Response('', { status: 502 });
        return jsonOk({ organizations: [{ login: 'acme-inc', avatarUrl: null }] });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(
      await screen.findByText(
        "Motir couldn't reach your GitHub organizations just now, so only your personal account is listed.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('option', { name: /yue-personal/ })).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /acme-inc/ })).toBeTruthy();
  });

  it('states the three real costs before the commit — and never says "one click"', async () => {
    renderRoom({ rows: [hostedRow()] });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    await click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('What this takes')).toBeTruthy();
    expect(screen.getByText('A GitHub account you own.')).toBeTruthy();
    // The asynchrony is stated in the AFFIRMATIVE — the ADR's honesty rule is
    // the point of the panel, not a caveat beneath it.
    expect(screen.getByText("A transfer you accept on GitHub. It isn't instant.")).toBeTruthy();
    expect(screen.getByText('Re-installing the Motir app on the new owner.')).toBeTruthy();
    expect(
      screen.getByText(
        'GitHub bills you for Actions directly from then on, and Motir stops charging CI credits.',
      ),
    ).toBeTruthy();

    const body = document.body.textContent ?? '';
    for (const banned of ['one click', 'One click', 'instantly', 'simply']) {
      expect(body).not.toContain(banned);
    }
  });

  it('reuses MOTIR-1900’s connect prompt when there is no GitHub identity — not a failure', async () => {
    renderRoom({ rows: [hostedRow()], githubLogin: null });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(await screen.findByRole('dialog', { name: 'Connect GitHub first' })).toBeTruthy();
    // MOTIR-1900's own copy and its two actions, verbatim — no second prompt.
    expect(screen.getByText(enMessages.repositorySet.accessLead)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect GitHub' }).getAttribute('href')).toBe(
      '/settings/workspace/github',
    );
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
    // No picker, and nothing to confirm.
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the page-state contract after a takeover (§14.10)', () => {
  it('applies the returned row LOCALLY and refreshes the server-rendered header — both', async () => {
    const moved: ProjectRepoDto = hostedRow({
      takeover: takeover({ state: 'transfer_pending' }),
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return jsonOk({ row: moved, state: 'transfer_pending', transferAccepted: false });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    await click(await screen.findByRole('button', { name: 'Continue' }));
    await click(await screen.findByRole('button', { name: 'Move this repository' }));

    // Surface 1 — the row shows what the mutation RETURNED.
    expect(await screen.findByText('Waiting for you to accept on GitHub')).toBeTruthy();

    // Surface 2 — the server-rendered summary + paused banner. `router.refresh()`
    // is the ONLY thing that reaches them, so its absence is a real half-update.
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    // …and surface 1 was NOT re-read: a refresh of the acted-on row is what
    // causes the visible revert this contract exists to prevent.
    const rereads = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/repositories') &&
        (init as RequestInit | undefined)?.method !== 'POST',
    );
    expect(rereads).toHaveLength(0);
  });

  it('sends the chosen owner, and posts NO body for a Check again re-probe', async () => {
    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });

    await click(screen.getByRole('button', { name: /Check .* again/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      // No `newOwner` → the completion probe, which is a no-op on a row that is
      // not awaiting a re-install and therefore always safe to press.
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({});
    });
  });

  it('surfaces a refused mutation and re-reads, rather than asserting a state the server denied', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 'PROJECT_REPO_TAKEOVER_STATE' }), {
          status: 409,
        });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });
    await click(screen.getByRole('button', { name: /Check .* again/ }));

    const alert = await screen.findByText(
      "That didn't go through. Nothing was changed — try again.",
    );
    expect(alert).toBeTruthy();
    await waitFor(() => {
      const reread = fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/repositories') &&
          (init as RequestInit | undefined)?.method !== 'POST',
      );
      expect(reread).toBe(true);
    });
  });
});

describe('rows are independent (MOTIR-711, panel 8)', () => {
  it('leaves the other two rows rendering and pressable while one is mid-move', async () => {
    // A takeover that never resolves, so the busy window is a state to assert in
    // rather than a race to catch.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Promise(() => {}) as unknown as Response;
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({
      rows: [
        hostedRow(),
        hostedRow({ id: 'row-api', role: 'api', name: 'acme-booking-api' }),
        connectedRow(),
      ],
    });

    await click(
      screen.getByRole('button', { name: 'Move motir-projects/acme-booking-web to my GitHub' }),
    );
    await click(await screen.findByRole('button', { name: 'Continue' }));
    await click(await screen.findByRole('button', { name: 'Move this repository' }));

    // The sibling is untouched: still Motir-hosted, still offering its own move,
    // and still ENABLED — a set-level busy flag would fail exactly here.
    const sibling = screen.getByTestId('takeover-row-api');
    expect(within(sibling).getByText('Created')).toBeTruthy();
    const siblingAction = within(sibling).getByRole('button', {
      name: 'Move motir-projects/acme-booking-api to my GitHub',
    });
    expect(siblingAction).toHaveProperty('disabled', false);

    // …and the row that was never Motir's is unaffected by any of it.
    expect(within(screen.getByTestId('takeover-row-shared')).getByText('Yours')).toBeTruthy();
  });

  it('counts three ownerships at once without implying the project is "moving"', () => {
    // The header summary is the PAGE's (server-rendered); what the island must
    // not do is collapse three legal states into one. Proven by all three
    // rendering their own state word side by side.
    renderRoom({
      rows: [
        hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) }),
        hostedRow({ id: 'row-api', role: 'api', name: 'acme-booking-api' }),
        connectedRow(),
      ],
    });
    expect(screen.getByText('Install Motir on yue-personal')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Yours')).toBeTruthy();
  });
});

describe('the polled async job (§14.10)', () => {
  it('re-reads the set while a hand-off is in flight, and stops once nothing is', async () => {
    vi.useFakeTimers();
    const { unmount } = renderRoom({
      rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/repositories'))).toBe(true);

    unmount();
    const after = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // The interval is cleaned up on unmount — a settings page left open must not
    // keep polling a surface nobody is looking at.
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('does not poll a set where every row has settled', async () => {
    vi.useFakeTimers();
    renderRoom({ rows: [hostedRow(), connectedRow()] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/repositories')),
    ).toHaveLength(0);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function renderRoom(overrides: Partial<ProjectRepoRoomViewDto> & { rows: ProjectRepoDto[] }) {
  const view: ProjectRepoRoomViewDto = {
    projectId: 'proj-1',
    hostOwner: 'motir-projects',
    githubLogin: 'yue-personal',
    githubAvatarUrl: null,
    installHref: 'https://github.com/apps/motir/installations/new',
    ciPaused: false,
    otherHostedProjects: [],
    ...overrides,
  };
  currentRows = view.rows;
  return renderWithIntl(
    <RepositoriesRoom
      projectKey="ACME"
      view={view}
      connectHref="/settings/workspace/github"
      nowIso={NOW}
    />,
  );
}

function hostedRow(overrides: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  const name = overrides.name ?? 'acme-booking-web';
  return {
    id: 'row-web',
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name,
    seedSource: 'platform-starter',
    state: 'created',
    failureReason: null,
    proposalSignal: 'default-web',
    realizedRepo: {
      id: 'gh-1',
      provider: 'github',
      owner: 'motir-projects',
      name,
      repoRef: `motir-projects/${name}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: null,
    access: { state: 'accepted', login: 'yue-personal', invitationUrl: null },
    position: 'a0',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A repository the user brought in — the already-yours no-op. */
function connectedRow(): ProjectRepoDto {
  return {
    ...hostedRow({ id: 'row-shared', role: 'shared', name: 'design-tokens' }),
    state: 'connected',
    realizedRepo: {
      id: 'gh-2',
      provider: 'github',
      owner: 'acme-inc',
      name: 'design-tokens',
      repoRef: 'acme-inc/design-tokens',
      defaultBranch: 'main',
      archived: false,
    },
  };
}

function takeover(overrides: Partial<ProjectRepoTakeoverDto> = {}): ProjectRepoTakeoverDto {
  return {
    state: 'transfer_pending',
    targetOwner: 'yue-personal',
    requestedAt: NOW,
    transferredAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

function defaultFetch(url: string): unknown {
  if (url.includes('/api/github/organizations')) {
    return { organizations: [{ login: 'acme-inc', avatarUrl: null }] };
  }
  return { set: { rows: currentRows } };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A click that also drains the effect pass it triggers.
 *
 * `fireEvent` dispatches synchronously, but the handlers here start async work
 * whose `setState` lands in a later microtask + passive-effect flush. Awaiting an
 * empty `act` after the dispatch is what makes the assertion that follows read
 * settled state instead of racing it — the component-test half of the repo's
 * authoritative-signal rule.
 */
async function click(target: Element): Promise<void> {
  fireEvent.click(target);
  await act(async () => {});
}
