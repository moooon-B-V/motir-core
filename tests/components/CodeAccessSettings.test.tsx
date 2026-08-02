// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeAccessSettings } from '@/app/(authed)/settings/project/code-access/_components/CodeAccessSettings';
import type {
  ProjectRepoDto,
  ProjectRepoMemberAccessDto,
  ProjectRepoTeamAccessDto,
} from '@/lib/dto/projectRepos';

// THE TEAM CODE-ACCESS SURFACE (Story MOTIR-1775 · MOTIR-1945 ·
// design/repository-set §15).
//
// What this file pins is mostly about WHO MAY ACT, because that is the part a
// future edit is most likely to quietly break:
//   * `Connect GitHub` appears on your OWN row and on nobody else's — a teammate
//     viewing that row gets the reason and NO control, not a disabled one;
//   * a member who cannot edit the project sees every state and no action, plus a
//     sentence saying whose job it is;
//   * an invitation GitHub refuses leaves the repository real and the row
//     retryable — it never renders as a failed repository;
//   * every state carries an icon AND a word, so nothing is signalled by colour.

const REPO_DEFAULTS = {
  projectId: 'proj-1',
  label: null,
  seedSource: 'nextjs-prisma-vercel-starter',
  failureReason: null,
  proposalSignal: null,
  takeover: null,
  access: { state: 'not_invited', login: null, invitationUrl: null },
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T10:00:00.000Z',
} as const;

function repo(over: Partial<ProjectRepoDto> & { id: string; name: string }): ProjectRepoDto {
  const state = over.state ?? 'created';
  const established = over.established ?? (state === 'created' || state === 'connected');
  return {
    ...REPO_DEFAULTS,
    role: 'web',
    position: 'a0',
    state,
    established,
    realizedRepo: established
      ? {
          id: `gh-${over.id}`,
          provider: 'github',
          owner: 'motir-projects',
          name: over.name,
          repoRef: `motir-projects/${over.name}`,
          defaultBranch: 'main',
          archived: false,
        }
      : null,
    ...over,
  } as ProjectRepoDto;
}

function member(
  over: Partial<ProjectRepoMemberAccessDto> & { userId: string; name: string },
): ProjectRepoMemberAccessDto {
  return {
    email: `${over.userId}@northwind.test`,
    eligible: true,
    login: `${over.userId}gh`,
    permission: null,
    state: 'not_invited',
    reason: null,
    invitationUrl: null,
    invitedAt: null,
    acceptedAt: null,
    ...over,
  };
}

const WEB = repo({ id: 'row-web', name: 'atlas-web' });
const API = repo({ id: 'row-api', name: 'atlas-api', role: 'api' });

function access(
  rows: { repo: ProjectRepoDto; members: ProjectRepoMemberAccessDto[]; invitable?: boolean }[],
): ProjectRepoTeamAccessDto {
  return {
    projectId: 'proj-1',
    rows: rows.map((r) => ({
      rowId: r.repo.id,
      repoRef: r.repo.realizedRepo?.repoRef ?? null,
      invitable: r.invitable ?? r.repo.state === 'created',
      members: r.members,
    })),
  };
}

const OLIVIA = member({
  userId: 'olivia',
  name: 'Olivia Owner',
  state: 'accepted',
  permission: 'admin',
});
const PRIYA = member({
  userId: 'priya',
  name: 'Priya Nair',
  state: 'invited',
  permission: 'push',
  invitationUrl: 'https://github.com/motir-projects/atlas-web/invitations',
});
const DANA = member({
  userId: 'dana',
  name: 'Dana Ostrowski',
  login: null,
  reason: 'no_github_identity',
});
const SOFIA = member({ userId: 'sofia', name: 'Sofia Marchetti' });
const TOM = member({
  userId: 'tom',
  name: 'Tom Bekele',
  eligible: false,
  reason: 'role_cannot_edit',
});

const TEAM = [OLIVIA, PRIYA, DANA, SOFIA, TOM];

function renderSurface(
  over: Partial<Parameters<typeof CodeAccessSettings>[0]> = {},
  rows = access([
    { repo: WEB, members: TEAM },
    { repo: API, members: TEAM },
  ]),
) {
  return renderWithIntl(
    <CodeAccessSettings
      projectKey="ATL"
      projectName="Atlas"
      initialAccess={rows}
      initialRepos={[WEB, API]}
      currentUserId="olivia"
      canEdit
      selfLogin="oliviagh"
      selfAvatarUrl={null}
      connectHref="/settings/workspace/github"
      plansHref="/plans"
      membersHref="/settings/project/members"
      {...over}
    />,
  );
}

/** The `<li>` a person's row renders in — every per-row assertion is scoped to
 *  it, never to the page (three altitudes of `Connect GitHub` live on this
 *  surface). */
function row(name: string): HTMLElement {
  const heading = screen.getByText(name, { selector: 'p' });
  const li = heading.closest('li');
  if (!li) throw new Error(`no row for ${name}`);
  return li;
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the room — every state, with its reason and its forward path', () => {
  it('renders each member in their real state, with an icon AND a word', () => {
    renderSurface();

    expect(within(row('Olivia Owner')).getByText('Has access')).toBeTruthy();
    expect(within(row('Priya Nair')).getByText('Invitation sent')).toBeTruthy();
    expect(within(row('Dana Ostrowski')).getByText('Not invited yet')).toBeTruthy();
    expect(within(row('Sofia Marchetti')).getByText('Not invited yet')).toBeTruthy();
    // Not eligible is its own card, not a greyed row in the list.
    expect(within(row('Tom Bekele')).getByText('No code access')).toBeTruthy();
    expect(screen.getByText('Not eligible')).toBeTruthy();

    // The two `not_invited` rows differ by REASON, which is what decides whether
    // anything can be done about them.
    expect(within(row('Sofia Marchetti')).getByText(/is ready to be invited/)).toBeTruthy();
    expect(
      within(row('Dana Ostrowski')).getByText(/hasn't connected a GitHub account/),
    ).toBeTruthy();
  });

  it('counts what is TRUE — a pending invitation is not access', () => {
    renderSurface();
    // Olivia accepted; Priya invited; Dana and Sofia not invited; Tom ineligible.
    expect(screen.getByText('1 of 4 can clone')).toBeTruthy();
  });

  it('names the repository set once, at the top', () => {
    renderSurface();
    expect(screen.getByText('2 repositories:')).toBeTruthy();
    expect(screen.getByText('motir-projects/atlas-web')).toBeTruthy();
    expect(screen.getByText('motir-projects/atlas-api')).toBeTruthy();
  });

  it('opens the per-repository expansion when the repositories disagree', () => {
    const rows = access([
      { repo: WEB, members: [member({ userId: 'jonas', name: 'Jonas Vik', state: 'accepted' })] },
      { repo: API, members: [member({ userId: 'jonas', name: 'Jonas Vik', state: 'invited' })] },
    ]);
    renderSurface({ currentUserId: 'jonas', selfLogin: 'jonasgh' }, rows);

    const jonas = row('Jonas Vik');
    const expander = within(jonas).getByRole('button', {
      name: 'Show per-repository access for Jonas Vik',
    });
    expect(expander.getAttribute('aria-expanded')).toBe('true');
    // Both repositories are named, each with its own state — the second
    // dimension, only where it is actually needed.
    expect(within(jonas).getByText('motir-projects/atlas-web')).toBeTruthy();
    expect(within(jonas).getByText('motir-projects/atlas-api')).toBeTruthy();
  });

  it('keeps the expansion closed when the repositories agree, and opens it on click', () => {
    renderSurface();
    const priya = row('Priya Nair');
    const expander = within(priya).getByRole('button', {
      name: 'Show per-repository access for Priya Nair',
    });
    expect(expander.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(expander);
    expect(expander.getAttribute('aria-expanded')).toBe('true');
    // A pending invitation has somewhere to open; an accepted one does not.
    expect(
      within(row('Priya Nair')).getAllByRole('link', { name: /^Open the invitation for Priya/ })
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('who may act (ADR §3 Q3)', () => {
  it("offers Connect GitHub on your OWN row and on nobody else's", () => {
    renderSurface({ currentUserId: 'dana', selfLogin: null });

    const dana = row('Dana Ostrowski');
    expect(within(dana).getByRole('link', { name: 'Connect GitHub' })).toBeTruthy();
    expect(within(dana).getByText(/Motir doesn't know your GitHub account yet/)).toBeTruthy();
    // The lead card — the one thing the signed-in member can do.
    expect(screen.getByText("You aren't connected to GitHub yet")).toBeTruthy();
  });

  it('gives a teammate the REASON and no control at all — not a disabled one', () => {
    renderSurface({ currentUserId: 'olivia', selfLogin: 'oliviagh' });

    const dana = row('Dana Ostrowski');
    expect(within(dana).queryByRole('link', { name: 'Connect GitHub' })).toBeNull();
    expect(within(dana).queryByRole('button')).toBeNull();
    expect(within(dana).getByText(/Only Dana Ostrowski can connect it/)).toBeTruthy();
  });

  it('shows a non-admin every state, no invite control, and whose job it is', () => {
    renderSurface({ currentUserId: 'priya', selfLogin: 'priyagh', canEdit: false });

    expect(screen.getByText(/Inviting somebody, and changing who's eligible/)).toBeTruthy();
    expect(within(row('Sofia Marchetti')).queryByRole('button', { name: /^Invite/ })).toBeNull();
    // The data is not hidden from them — only the actions that were never theirs.
    expect(within(row('Sofia Marchetti')).getByText('Not invited yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Change role' })).toBeNull();
  });

  it('offers nothing on a settled row — access granted is not an action', () => {
    renderSurface();
    const olivia = row('Olivia Owner');
    expect(within(olivia).queryByRole('button', { name: /Invite|Resend|Retry/ })).toBeNull();
    expect(within(olivia).getByText('Admin')).toBeTruthy();
  });
});

describe('inviting', () => {
  it('invites ONE member and reconciles the row from the response', async () => {
    const invited = access([
      {
        repo: WEB,
        members: TEAM.map((m) =>
          m.userId === 'sofia' ? { ...m, state: 'invited', permission: 'push' } : m,
        ),
      },
      {
        repo: API,
        members: TEAM.map((m) =>
          m.userId === 'sofia' ? { ...m, state: 'invited', permission: 'push' } : m,
        ),
      },
    ]);
    const spy = stubFetch(() => ({ access: invited, invited: 2, failed: 0, skippedNoIdentity: 0 }));
    renderSurface();

    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );

    await waitFor(() =>
      expect(within(row('Sofia Marchetti')).getByText('Invitation sent')).toBeTruthy(),
    );
    // Narrowed to that member: rows and members are independent, so inviting one
    // must never quietly re-send a neighbour's invitation.
    const [, init] = spy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ userId: 'sofia' });
    expect(spy.mock.calls[0]![0]).toContain('/api/projects/ATL/repositories/access/team');
  });

  it('a refusal leaves the repository real and the row retryable', async () => {
    // GitHub refused one of the two; MOTIR-1910 persists nothing on a refusal, so
    // the matrix comes back with that cell still uninvited.
    const partial = access([
      {
        repo: WEB,
        members: TEAM.map((m) =>
          m.userId === 'sofia' ? { ...m, state: 'invited', permission: 'push' } : m,
        ),
      },
      { repo: API, members: TEAM },
    ]);
    stubFetch(() => ({ access: partial, invited: 1, failed: 1, skippedNoIdentity: 0 }));
    renderSurface();

    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain("GitHub wouldn't take 1 of 2");
    const sofia = row('Sofia Marchetti');
    // The row's own state line says it once; the auto-opened expansion names the
    // repository it happened on.
    expect(within(sofia).getAllByText("Couldn't invite").length).toBeGreaterThan(0);
    expect(within(sofia).getByText(/turned the invitation down on/)).toBeTruthy();
    // The way back, and the repositories are still named as real.
    expect(
      within(sofia).getByRole('button', { name: 'Retry invitation for Sofia Marchetti' }),
    ).toBeTruthy();
    // The repository is still named as a real one in the set strip — a refused
    // invitation never renders as a failed repository.
    expect(
      screen
        .getAllByText('motir-projects/atlas-api')
        .some((el) => el.className.includes('font-mono')),
    ).toBe(true);
  });

  it('an invite Motir could not even send reads like one GitHub refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderSurface();

    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Both leave the repository real and the invitation retryable, and neither is
    // a state the reader can do anything different about.
    expect(
      within(row('Sofia Marchetti')).getByRole('button', {
        name: 'Retry invitation for Sofia Marchetti',
      }),
    ).toBeTruthy();
  });

  it('resends a pending invitation without touching its neighbours', async () => {
    const spy = stubFetch(() => ({
      access: access([
        { repo: WEB, members: TEAM },
        { repo: API, members: TEAM },
      ]),
      invited: 2,
      failed: 0,
      skippedNoIdentity: 0,
    }));
    renderSurface();

    fireEvent.click(
      within(row('Priya Nair')).getByRole('button', { name: 'Resend invitation for Priya Nair' }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(JSON.parse(String(spy.mock.calls[0]![1]?.body))).toEqual({ userId: 'priya' });
  });

  it('treats a refused HTTP status the same as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    renderSurface();

    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(within(row('Sofia Marchetti')).getAllByText("Couldn't invite").length).toBeGreaterThan(
      0,
    );
  });

  it('names each repository state inside the expansion', () => {
    // Invited on one repository, not on the other, with nothing refused — the
    // case the expansion exists for, opened because they disagree.
    const rows = access([
      {
        repo: WEB,
        members: [
          member({ userId: 'priya', name: 'Priya Nair', state: 'invited', permission: 'push' }),
        ],
      },
      { repo: API, members: [member({ userId: 'priya', name: 'Priya Nair' })] },
    ]);
    renderSurface({ currentUserId: 'olivia' }, rows);

    const priya = row('Priya Nair');
    expect(within(priya).getByText('2 repositories · 1 sent')).toBeTruthy();
    expect(within(priya).getAllByText('Invitation sent').length).toBe(2);
    expect(within(priya).getByText('Not invited yet')).toBeTruthy();
    // The permission is on the roll-up row AND on the repository it was granted on.
    expect(within(priya).getAllByText('Push').length).toBe(2);
  });

  it('discards a stale response — an older invite never clobbers a newer one', async () => {
    // Two per-row actions overlap, and the FIRST response comes back LAST.
    // Without the sequence guard the older matrix wins and the row the reader
    // just acted on silently reverts.
    const stale = access([
      { repo: WEB, members: TEAM },
      { repo: API, members: TEAM },
    ]);
    const fresh = access([
      {
        repo: WEB,
        members: TEAM.map((m) => (m.userId === 'priya' ? { ...m, state: 'accepted' as const } : m)),
      },
      {
        repo: API,
        members: TEAM.map((m) => (m.userId === 'priya' ? { ...m, state: 'accepted' as const } : m)),
      },
    ]);

    let releaseFirst: () => void = () => undefined;
    const firstLanded = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        const mine = call;
        if (mine === 1) await firstLanded;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access: mine === 1 ? stale : fresh,
            invited: 2,
            failed: 0,
            skippedNoIdentity: 0,
          }),
        };
      }),
    );
    renderSurface();

    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );
    fireEvent.click(
      within(row('Priya Nair')).getByRole('button', { name: 'Resend invitation for Priya Nair' }),
    );

    await waitFor(() => expect(within(row('Priya Nair')).getByText('Has access')).toBeTruthy());

    // The late first response carries the PRE-action matrix. Drain its whole
    // resolution chain (fetch → json → setState) before asserting: a `waitFor`
    // here would pass on the CURRENT DOM and never see the revert it is meant to
    // rule out.
    releaseFirst();
    for (let i = 0; i < 6; i += 1) await act(async () => {});
    expect(within(row('Priya Nair')).getByText('Has access')).toBeTruthy();
  });
});

describe('refreshing', () => {
  it('asks GitHub, then re-reads the matrix, and updates from the response', async () => {
    const settled = access([
      {
        repo: WEB,
        members: TEAM.map((m) => (m.userId === 'priya' ? { ...m, state: 'accepted' } : m)),
      },
      {
        repo: API,
        members: TEAM.map((m) => (m.userId === 'priya' ? { ...m, state: 'accepted' } : m)),
      },
    ]);
    const spy = stubFetch((url) => (url.endsWith('/team') ? settled : [WEB, API]));
    renderSurface();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh access from GitHub' }));

    await waitFor(() => expect(within(row('Priya Nair')).getByText('Has access')).toBeTruthy());
    // GitHub owns acceptance and tells Motir nothing when it happens, so the
    // read is the only honest way to learn it.
    expect(spy.mock.calls[0]![0]).toBe('/api/projects/ATL/repositories/access');
    expect(spy.mock.calls[1]![0]).toBe('/api/projects/ATL/repositories/access/team');
    expect(screen.getByText('2 of 4 can clone')).toBeTruthy();
  });

  it('discards a refresh that lands after a newer invite', async () => {
    // The two overlap for real: a refresh is in flight (its button is busy, but a
    // row's Invite is not), and its answer comes back describing the world BEFORE
    // the invite. It must not be applied.
    let releaseRefresh: () => void = () => undefined;
    const refreshReached = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const invited = access([
      {
        repo: WEB,
        members: TEAM.map((m) => (m.userId === 'sofia' ? { ...m, state: 'invited' as const } : m)),
      },
      {
        repo: API,
        members: TEAM.map((m) => (m.userId === 'sofia' ? { ...m, state: 'invited' as const } : m)),
      },
    ]);
    const stale = access([
      { repo: WEB, members: TEAM },
      { repo: API, members: TEAM },
    ]);
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        call += 1;
        if (call === 1) await refreshReached;
        return {
          ok: true,
          status: 200,
          json: async () =>
            init?.method === 'POST'
              ? { access: invited, invited: 2, failed: 0, skippedNoIdentity: 0 }
              : String(url).endsWith('/team')
                ? stale
                : [WEB, API],
        };
      }),
    );
    renderSurface();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh access from GitHub' }));
    fireEvent.click(
      within(row('Sofia Marchetti')).getByRole('button', { name: 'Invite Sofia Marchetti' }),
    );
    await waitFor(() =>
      expect(within(row('Sofia Marchetti')).getByText('Invitation sent')).toBeTruthy(),
    );

    releaseRefresh();
    for (let i = 0; i < 8; i += 1) await act(async () => {});
    expect(within(row('Sofia Marchetti')).getByText('Invitation sent')).toBeTruthy();
  });

  it('says so when the matrix re-read fails, having asked GitHub first', async () => {
    const spy = vi.fn(async (url: string) => ({
      ok: !String(url).endsWith('/team'),
      status: String(url).endsWith('/team') ? 500 : 200,
      json: async () => [WEB, API],
    }));
    vi.stubGlobal('fetch', spy);
    renderSurface();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh access from GitHub' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('says so when GitHub cannot be reached, and changes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    renderSurface();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh access from GitHub' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain("couldn't reach GitHub");
    expect(within(row('Priya Nair')).getByText('Invitation sent')).toBeTruthy();
  });
});

describe('the states that are not the happy one', () => {
  it('a project with no code is an invitation to review the plan, not an empty table', () => {
    renderSurface({ initialRepos: [] }, { projectId: 'proj-1', rows: [] });
    expect(screen.getByText('Atlas has no code yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review the plan' })).toBeTruthy();
    expect(screen.queryByText('People')).toBeNull();
  });

  it('a set still being made says so and promises nothing is lost', () => {
    const creating = repo({
      id: 'row-new',
      name: 'atlas-api',
      state: 'creating',
      established: false,
    });
    renderSurface(
      { initialRepos: [WEB, creating] },
      access([
        { repo: WEB, members: TEAM },
        { repo: creating, members: TEAM, invitable: false },
      ]),
    );
    expect(screen.getByText('Setting up')).toBeTruthy();
    // Scoped: every `not invited` line is a `role="status"` too, so the banner is
    // found by what it says rather than by being the only one.
    const banner = screen
      .getAllByRole('status')
      .find((el) => /still creating/.test(el.textContent ?? ''));
    expect(banner?.textContent).toContain('atlas-api');
    expect(banner?.textContent).toContain('nothing here is lost if you leave');
  });

  it('shows skeletons only while there is nothing truthful to show yet', () => {
    const creating = repo({
      id: 'row-new',
      name: 'atlas-web',
      state: 'creating',
      established: false,
    });
    const { container } = renderSurface(
      { initialRepos: [creating] },
      access([{ repo: creating, members: TEAM, invitable: false }]),
    );
    expect(screen.getByText('Setting up')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Olivia Owner')).toBeNull();
  });

  it('says plainly when Motir made no repository at all to grant', () => {
    const own = repo({ id: 'row-own', name: 'atlas-shared', state: 'connected' });
    renderSurface(
      { initialRepos: [own] },
      access([{ repo: own, members: TEAM, invitable: false }]),
    );
    expect(within(row('Olivia Owner')).getByText('Nothing to grant')).toBeTruthy();
    expect(screen.getByText('0 of 4 can clone')).toBeTruthy();
  });

  it('reads the single-repository case in the singular', () => {
    renderSurface({ initialRepos: [WEB] }, access([{ repo: WEB, members: TEAM }]));
    expect(screen.getByText('1 repository:')).toBeTruthy();
    expect(within(row('Olivia Owner')).getByText(/can clone and push to/)).toBeTruthy();
    expect(within(row('Olivia Owner')).queryByRole('button')).toBeNull();
  });

  it('points an admin at the pane that actually changes a role', () => {
    renderSurface();
    const tom = row('Tom Bekele');
    const link = within(tom).getByRole('link', { name: "Change Tom Bekele's project role" });
    expect(link.getAttribute('href')).toBe('/settings/project/members');
    // The reason, not a control this surface owns.
    expect(within(tom).getByText(/Viewers can read Atlas but not edit it/)).toBeTruthy();
  });

  it('shows a connected member WHICH account Motir will invite, until it is settled', () => {
    renderSurface({ currentUserId: 'priya', selfLogin: 'priyagh' });
    // The identity card names it once; their own row's reason names it again.
    expect(screen.getAllByText('@priyagh').length).toBeGreaterThan(0);
    expect(
      screen.getByText("The GitHub account Motir invites to this project's code"),
    ).toBeTruthy();
    const useOther = screen.getByRole('link', { name: 'Use a different account' });
    expect(useOther.getAttribute('href')).toBe('/settings/workspace/github');
  });

  it('drops that card once the member can actually clone', () => {
    renderSurface({ currentUserId: 'olivia', selfLogin: 'oliviagh' });
    expect(screen.queryByText('Use a different account')).toBeNull();
    expect(screen.queryByText("You aren't connected to GitHub yet")).toBeNull();
  });

  it('a partial set counts only the repositories Motir made', () => {
    const own = repo({ id: 'row-own', name: 'atlas-shared', state: 'connected' });
    renderSurface(
      { initialRepos: [WEB, own] },
      access([
        { repo: WEB, members: TEAM },
        { repo: own, members: TEAM, invitable: false },
      ]),
    );
    expect(screen.getByText(/Only the repositories Motir made are counted/)).toBeTruthy();
    expect(screen.getByText('· yours')).toBeTruthy();
  });
});

describe('a11y', () => {
  it('has no axe violations, and announces the state that changes elsewhere', async () => {
    const { container } = renderSurface({ currentUserId: 'dana', selfLogin: null });

    // A member who connects in another tab and comes back must hear the change.
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((s) => /Not invited yet/.test(s.textContent ?? ''))).toBe(true);

    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
