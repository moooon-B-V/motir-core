// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import type {
  ProjectRepoDto,
  ProjectRepoEstablishViewDto,
  ProjectRepoStateDto,
} from '@/lib/dto/projectRepos';

// THE ESTABLISH STEP (Story MOTIR-1775 · MOTIR-1782 · design/repository-set).
//
// The card's central claim is a NEGATIVE one, so most of what is asserted here is
// what must NOT be on screen: a one-repository plan and a three-repository plan
// render the IDENTICAL default screen, and no repository name, count, role, org,
// seed source or GitHub status code reaches it. That is the `notes.html` #151 rule
// — an AI-derived artifact a non-technical user cannot judge is derived and used,
// never put behind an editor — and it is only true if a test says so, because
// every future change to this file is a chance to leak one word of it.
//
// The technical path is asserted for the opposite property: once the user has
// self-identified by connecting their own GitHub, the vocabulary IS theirs, per-row
// state is independent, and no state is a dead end.

const ROW_DEFAULTS = {
  projectId: 'proj-1',
  label: null,
  seedSource: 'nextjs-prisma-vercel-starter',
  failureReason: null,
  proposalSignal: null,
  realizedRepo: null,
  established: false,
  // The TAKE-IT-OVER saga (MOTIR-711) — null is the common case: no handoff has
  // ever been requested for this row.
  takeover: null,
  // The collaborator invitation (MOTIR-1900) — a sub-state OF a created row, so
  // the default is the honest "nobody has been invited to this yet".
  access: { state: 'not_invited', login: null, invitationUrl: null },
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
} as const;

function row(
  over: Partial<ProjectRepoDto> & { id: string; role: ProjectRepoDto['role']; name: string },
): ProjectRepoDto {
  return {
    ...ROW_DEFAULTS,
    state: 'proposed' as ProjectRepoStateDto,
    position: 'a0',
    ...over,
  };
}

function view(
  rows: ProjectRepoDto[],
  over: Partial<ProjectRepoEstablishViewDto> = {},
): ProjectRepoEstablishViewDto {
  return {
    set: { projectId: 'proj-1', rows, ownership: null, targetAccount: null },
    hostOwner: 'motir-projects',
    githubLogin: null,
    githubAvatarUrl: null,
    hasInstallation: false,
    connectCandidates: [],
    ...over,
  };
}

/** The step polls + writes through `fetch`; every test drives it explicitly so
 *  nothing depends on a real network or on timing. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderStep(initial: ProjectRepoEstablishViewDto) {
  return renderWithIntl(
    <RepositorySetStep
      projectKey="MOTIR"
      initialView={initial}
      backlogHref="/items"
      connectHref="/settings/workspace/github"
    />,
  );
}

beforeEach(() => {
  stubFetch(() => view([]));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The DEFAULT path ────────────────────────────────────────────────────────

describe('the default path', () => {
  it('is one sentence and ONE action — no branch, and nothing technical', () => {
    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    expect(screen.getByRole('heading', { name: 'Motir will host your code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    // ⚠️ THE DOOR IS GONE, and its ABSENCE is the assertion (MOTIR-5014). The
    // quiet secondary led to the technical path, which left for onboarding — a
    // user who already has code answered that question there, before any plan
    // existed. Asserting the absence is what stops it being re-added by
    // somebody reading the panel as unfinished.
    expect(screen.queryByRole('button', { name: 'I already have code' })).toBeNull();

    // The ownership promise is on the MAIN LINE, not in a footnote — it is the
    // line MOTIR-1785's acceptance video must be able to show.
    expect(container.textContent).toContain("It's yours.");

    // …and none of the model reaches the screen.
    const text = container.textContent ?? '';
    for (const leak of ['acme-booking-web', 'motir-projects', 'web', 'repositor', 'starter']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('renders the IDENTICAL screen for a one-repo plan and a three-repo plan', () => {
    // The card's central claim, answered by REMOVING the question rather than by
    // styling it two ways: cardinality is not the user's business, so nothing
    // about it can reach the DOM.
    const one = renderStep(view([row({ id: 'r1', role: 'web', name: 'solo' })]));
    const oneHtml = one.container.innerHTML;
    cleanup();

    const three = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'acme-web', position: 'a0' }),
        row({ id: 'r2', role: 'api', name: 'acme-api', position: 'a1' }),
        row({ id: 'r3', role: 'shared', name: 'acme-shared', position: 'a2' }),
      ]),
    );

    expect(three.container.innerHTML).toBe(oneHtml);
  });

  it('goes working → ready on Continue, and never names a repository on the way', async () => {
    let phase: ProjectRepoStateDto = 'proposed';
    stubFetch((url) => {
      if (url.endsWith('/establish')) {
        phase = 'created';
        return { projectId: 'proj-1', rows: [] };
      }
      return view([row({ id: 'r1', role: 'web', name: 'acme-booking-web', state: phase })]);
    });

    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('repo-setup-status').textContent).toContain('Your code is ready');
    });
    expect(screen.getByRole('link', { name: 'Go to my backlog' })).toBeTruthy();
    expect(container.textContent).not.toContain('acme-booking-web');
  });

  it('shows ONE status line while creating, however many repositories are behind it', () => {
    const { container } = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'a', state: 'creating' }),
        row({ id: 'r2', role: 'api', name: 'b', state: 'creating' }),
      ]),
    );

    const statuses = container.querySelectorAll('[data-testid="repo-setup-status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toContain('Setting up your code…');
    expect(statuses[0]!.getAttribute('role')).toBe('status');
  });

  it('reports a failure in plain language — no repository name, no GitHub status code', () => {
    const { container } = renderStep(
      view([
        row({
          id: 'r1',
          role: 'web',
          name: 'acme-booking-web',
          state: 'failed',
          // A REAL reason, of the shape the primitive persists. The default path
          // must render none of it.
          failureReason: 'GitHub declined the request (422) for "acme-booking-web".',
        }),
      ]),
    );

    expect(screen.getByTestId('repo-setup-status').textContent).toContain(
      "Motir couldn't finish setting up your code",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('Your plan is safe in your backlog.');
    expect(text).not.toContain('acme-booking-web');
    expect(text).not.toContain('422');
    expect(text).not.toContain('GitHub declined');
    // The failure is ANNOUNCED, not just coloured.
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('has no axe violations in any of its states', async () => {
    for (const state of ['proposed', 'creating', 'created', 'failed'] as ProjectRepoStateDto[]) {
      const { container } = renderStep(
        view([
          row({
            id: 'r1',
            role: 'web',
            name: 'acme-web',
            state,
            failureReason: state === 'failed' ? 'nope' : null,
          }),
        ]),
      );
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
      cleanup();
    }
  });
});

describe('the step’s remaining edges', () => {
  it('POLLS while a run is in flight, and stops the moment nothing is', async () => {
    vi.useFakeTimers();
    try {
      let state: ProjectRepoStateDto = 'creating';
      const spy = stubFetch(() => view([row({ id: 'r1', role: 'web', name: 'a', state })]));
      renderStep(view([row({ id: 'r1', role: 'web', name: 'a', state: 'creating' })]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3200);
      });
      const whileRunning = spy.mock.calls.length;
      expect(whileRunning).toBeGreaterThanOrEqual(2);

      // The set settles; the poll must stop rather than hammer the read forever.
      state = 'created';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      const afterSettle = spy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(spy.mock.calls.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  /* ⚠️ THREE CASES WERE REMOVED HERE, NOT SKIPPED (MOTIR-5014 · Story MOTIR-5010):
     the anonymous greeting on the set lead, "Not now" leaving the technical path,
     and the failed-`addRow` alert. All three entered through **I already have
     code**, which is gone — the technical path left for onboarding, so there is no
     surface left for them to drive. The establish-failure half of the third is
     still covered by the `failed` panel case in `the default path` above, which is
     where a user now meets it. */

  it('renders the idle default for a project whose set is empty', () => {
    // Not reachable from the plan page (which mounts the step only for a project
    // that HAS a set), but the derivation must not read an empty set as "ready".
    renderStep(view([]));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByTestId('repo-setup-status')).toBeNull();
  });
});

// ── THE ACCESS STEP (MOTIR-1900 · design/repository-set §5, panels 3 + 4) ────
//
// Repositories Motir creates live in Motir's org and are PRIVATE, so "your code
// is ready" is only half true until the user can reach it. What is asserted here
// is that the surface tells that truth: the main line continues into the access
// step, the account is SHOWN rather than typed, `Later` is a real answer, and
// each of the three invitation states carries an icon AND a word plus its one way
// forward.

const ACCESS = {
  notInvited: { state: 'not_invited', login: null, invitationUrl: null },
  invited: {
    state: 'invited',
    login: 'yuezhu',
    invitationUrl: 'https://github.com/motir-projects/acme-web/invitations',
  },
  accepted: { state: 'accepted', login: 'yuezhu', invitationUrl: null },
} as const;

/** A settled, Motir-created row — the only shape that raises an access question. */
function createdRow(access: ProjectRepoDto['access']): ProjectRepoDto {
  return row({
    id: 'r1',
    role: 'web',
    name: 'acme-web',
    state: 'created',
    established: true,
    access,
    realizedRepo: {
      id: 'gr-1',
      provider: 'github',
      owner: 'motir-projects',
      name: 'acme-web',
      repoRef: 'motir-projects/acme-web',
      defaultBranch: 'main',
      archived: false,
    },
  });
}

/**
 * Serve BOTH shapes the access step reads: the set (`GET ../repositories`, an
 * establish view) and the acceptance refresh (`GET ../repositories/access`, a
 * bare row array). Getting the second wrong is not a detail — the step folds its
 * result straight into `view.set.rows`.
 */
function stubAccessFetch(v: ProjectRepoEstablishViewDto) {
  return stubFetch((url) => (String(url).endsWith('/access') ? v.set.rows : v));
}

describe('the main line continues into the access step', () => {
  it('a READY set offers Connect GitHub as the primary, with the backlog as the quiet way out', async () => {
    const v = view([createdRow(ACCESS.notInvited)]);
    stubAccessFetch(v);
    renderStep(v);

    // The code exists — and the next thing the user needs is a way to reach it.
    expect(await screen.findByText('Your code is ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to my backlog' })).toBeTruthy();
  });

  it('asks for the ACCOUNT, never a username FIELD — a typed handle would invite a stranger', async () => {
    const v = view([createdRow(ACCESS.notInvited)]);
    stubAccessFetch(v);
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByText('Get access to your code')).toBeTruthy();
    expect(screen.getByText(/Motir invites the GitHub account you connect/)).toBeTruthy();
    // The hand-off is the shipped connect pane; there is no field to mistype into.
    expect(screen.getByRole('link', { name: /Connect GitHub/ })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('SHOWS which account got access once connected, with a way to change it', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    // The shipped `IdentityHeader`, so the account on screen is the account the
    // product knows — and correcting it re-runs the connect rather than opening
    // a field.
    expect(await screen.findByText('@yuezhu')).toBeTruthy();
    expect(screen.getByText('This is the account Motir invited')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Use a different account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open the invitation/ })).toBeTruthy();
  });

  it('LATER is a real answer — it leaves with everything intact', async () => {
    const v = view([createdRow(ACCESS.notInvited)]);
    stubAccessFetch(v);
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));

    // Back to the settled step, plan and code untouched. `Later` (not "Not now",
    // which this surface already uses at the technical path's footer).
    expect(await screen.findByText('Your code is ready')).toBeTruthy();
  });

  it('has no axe violations on the access step', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    const { container } = renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    await screen.findByText('@yuezhu');

    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
describe('the access step SENDS the invitations', () => {
  /** A `created` row nobody has been invited to, for a CONNECTED user — the one
   *  shape whose access-step primary is the grant button rather than a link out. */
  const connectedNotInvited = () =>
    view([createdRow(ACCESS.notInvited)], { githubLogin: 'yuezhu', githubAvatarUrl: null });

  /** Serve the three reads the step makes, so only the POST changes anything:
   *  the set (`GET ../repositories`), the acceptance refresh (`GET ../access`,
   *  a bare array) and the grant (`POST ../access`). */
  function stubAccess(opts: {
    rows: ProjectRepoDto[];
    refreshed?: ProjectRepoDto[];
    grant?: unknown;
    view: ProjectRepoEstablishViewDto;
  }) {
    return stubFetch((url, init) => {
      const u = String(url);
      if (u.endsWith('/access')) {
        if (init?.method === 'POST') {
          return opts.grant ?? { rows: opts.rows, login: 'yuezhu', invited: 1, failed: 0 };
        }
        return opts.refreshed ?? opts.rows;
      }
      return opts.view;
    });
  }

  function posts(spy: ReturnType<typeof stubFetch>) {
    return spy.mock.calls.filter(
      ([u, init]) => String(u).endsWith('/access') && (init as RequestInit)?.method === 'POST',
    );
  }

  it('POSTs the grant and keeps the RESPONSE as the confirmation', async () => {
    const v = connectedNotInvited();
    const spy = stubAccess({
      rows: [createdRow(ACCESS.notInvited)],
      grant: { rows: [createdRow(ACCESS.invited)], login: 'yuezhu', invited: 1, failed: 0 },
      view: v,
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    // The access step for a connected-but-uninvited user: the primary IS the grant.
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    // The rows the grant RETURNED are kept — the step does not re-read the set to
    // learn what it was just told (design §12: the response IS the confirmation,
    // and a refresh here would only risk a visible revert).
    expect(await screen.findByRole('link', { name: /Open the invitation/ })).toBeTruthy();
    expect(posts(spy)).toHaveLength(1);
    expect(JSON.parse(String((posts(spy)[0]![1] as RequestInit).body))).toEqual({});
  });

  it('reports a GitHub refusal — a `failed` count is an error the user must see', async () => {
    const v = connectedNotInvited();
    stubAccess({
      rows: [createdRow(ACCESS.notInvited)],
      grant: { rows: [createdRow(ACCESS.notInvited)], login: 'yuezhu', invited: 0, failed: 1 },
      view: v,
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      "Motir couldn't send the invitation",
    );
  });

  it('reports a failed REQUEST the same way — a throw is not silence', async () => {
    const v = connectedNotInvited();
    stubFetch((url, init) => {
      if (String(url).endsWith('/access') && init?.method === 'POST') throw new Error('network');
      return String(url).endsWith('/access') ? [createdRow(ACCESS.notInvited)] : v;
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      "Motir couldn't send the invitation",
    );
  });

  it('a `login: null` response is the CONNECT PROMPT, never an error', async () => {
    const v = connectedNotInvited();
    const spy = stubAccess({
      rows: [createdRow(ACCESS.notInvited)],
      grant: { rows: [createdRow(ACCESS.notInvited)], login: null, invited: 0, failed: 0 },
      view: v,
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    // Not having connected is a state the panel already renders as a prompt (off
    // `githubLogin`, not off this response). Showing it as a failure would blame
    // the user for a step they never took — so `failed: 0` raises nothing, even
    // though nothing was invited.
    await waitFor(() => expect(posts(spy)).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('REFRESHES the pending invitations on entering the step, and folds them in', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    const spy = stubAccess({
      rows: [createdRow(ACCESS.invited)],
      // The user accepted on GitHub while Motir was not looking.
      refreshed: [createdRow(ACCESS.accepted)],
      view: v,
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    // GitHub tells Motir nothing when an invitation is accepted, so entering the
    // step is when it asks — and the answer replaces the rows on screen. The
    // pending invitation's door goes with it rather than pointing at a 404.
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([u, init]) =>
            String(u).endsWith('/access') && ((init as RequestInit)?.method ?? 'GET') === 'GET',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /Open the invitation/ })).toBeNull(),
    );
  });

  it('survives a refresh that fails — the row keeps saying what it last knew', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubFetch((url, init) => {
      if (String(url).endsWith('/access') && (init?.method ?? 'GET') === 'GET') {
        throw new Error('refresh unreachable');
      }
      return v;
    });
    renderStep(v);
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }));

    // Best-effort: an unreachable refresh must not blank the invitation the user
    // can see, and must not surface as a failure they cannot act on.
    expect(await screen.findByText('@yuezhu')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open the invitation/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /* ⚠️ ONE CASE WAS REMOVED HERE, NOT SKIPPED (MOTIR-5014 · Story MOTIR-5010) —
     a row's per-row **Resend invitation**. Its own comment named the reason it can
     no longer run: *"the technical path … is the only surface that renders a
     per-row Resend"*, and that surface is gone.

     ⚠️ AND THAT LEAVES A LIVE CAPABILITY WITH NO SURFACE, which is a finding for
     MOTIR-5015 rather than something this card may fix: `grantAccess(rowId)` and
     `grantRepositoryAccess(projectKey, rowId)` still take a row id, and the route
     still narrows on it, but nothing renders a control that passes one. Either the
     access step grows the affordance or the row parameter goes — that decision
     belongs to the card that owns the access step, not to the one that deleted the
     technical path. */
});
