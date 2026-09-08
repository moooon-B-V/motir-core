// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { summarizeRepositories } from '@/lib/projectRepos/roomSections';
import type { OrgRepoOptionDto } from '@/lib/dto/organizationRepos';
import type {
  ProjectRepoConnectedDto,
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
} from '@/lib/dto/projectRepos';

// THE ROOM AS AN ORG ADMIN SEES IT (Story MOTIR-4669 · MOTIR-4681).
//
// `tests/components/repositories-room.test.tsx` renders this room as it stood
// before the tier move, and it renders it as a NON-admin — every case there is
// about the Motir-hosted takeover flow. That is the right altitude for that file
// and it leaves this story's half of the component completely unexercised: the
// organisation section, the add door, the picker's fetch, and the two ways each
// of the room's two writes can fail.
//
// ⚠️ EVERY CASE HERE IS A WIRE-LEVEL ONE. The room owns three things that only a
// mounted component can be asked about, and each has already been got wrong once
// in this story:
//
//   1. THE PICKER'S LIST IS FETCHED ON OPEN, not on render — it is an org-scoped
//      read across workspaces, and a room nobody adds from must not pay for it.
//   2. A PICK APPLIES BOTH SURFACES of the page-state contract: the new row goes
//      into THIS island optimistically (`router.refresh()` provably cannot reach
//      a `useState`-seeded list) AND the refresh fires for the server-rendered
//      header summary, which counts over both registries.
//   3. A PROJECT WITH NOTHING, whose actor MAY ADD, gets the picker — never the
//      empty state's signpost. `design/repository-set/design-notes.md` §17.4
//      forbids that shape at this exact moment, and the acceptance walk
//      (MOTIR-4685) is what caught the room shipping it.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const OPTION = (id: string, full: string): OrgRepoOptionDto => ({
  id,
  owner: full.split('/')[0]!,
  name: full.split('/')[1]!,
  fullName: full,
  defaultBranch: 'main',
  provider: 'github',
  archived: false,
  connectedFromWorkspaceId: 'ws1',
});

const ORG_ROW = (id: string, name: string): ProjectRepoDto =>
  ({
    id,
    projectId: 'proj-1',
    role: 'api',
    label: null,
    name,
    seedSource: SEED_SOURCE_ORGANIZATION,
    state: 'connected',
    failureReason: null,
    proposalSignal: null,
    realizedRepo: {
      id: `gr-${id}`,
      provider: 'github',
      owner: 'moooon',
      name,
      repoRef: `moooon/${name}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: null,
    access: null,
    position: 'a0',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }) as unknown as ProjectRepoDto;

function view(rows: ProjectRepoDto[]): ProjectRepoRoomViewDto {
  return {
    projectId: 'proj-1',
    rows,
    hostOwner: 'motir-projects',
    githubLogin: 'yue-personal',
    githubAvatarUrl: null,
    installHref: 'https://github.com/apps/motir/installations/new',
    ciPaused: false,
    otherHostedProjects: [],
    connected: [],
    connectedInDomain: false,
  } as unknown as ProjectRepoRoomViewDto;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The room, mounted as somebody who administers the organisation. */
function room(rows: ProjectRepoDto[], canAdd = true) {
  renderWithIntl(
    <RepositoriesRoom
      projectKey="ACME"
      view={view(rows)}
      connectHref="/settings/account/git"
      canAddRepositories={canAdd}
      organizationName="moooon"
      organizationInventoryHref="/settings/organization/git"
      nowIso="2026-09-06T12:00:00.000Z"
    />,
  );
}

/** One `fetch` answer, in the shape the room reads it. */
function answer(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe('the organisation section, and the room’s one add door', () => {
  it('renders the section for a project that HOLDS an organisation repository', () => {
    room([ORG_ROW('r1', 'motir-core')]);
    expect(screen.getByText('From your organisation')).toBeTruthy();
    // The row prints the owner and the name in separate spans, so it is asked
    // for by the half that identifies it.
    expect(screen.getByText('motir-core')).toBeTruthy();
    expect(screen.getByText('See every repository in moooon')).toBeTruthy();
  });

  it('⚠️ renders it for a project that holds NOTHING, when the actor may add', () => {
    // §17.4. The early empty state is a signpost — a panel whose one action is a
    // link to another page — and for somebody who can add here that turns one
    // intent into two errands. The section's own zero case is the PICKER.
    room([]);
    expect(screen.getByRole('button', { name: /Add repository/i })).toBeTruthy();
  });

  it('⚠️ and NOT for a project that holds nothing whose actor may NOT add', () => {
    // The other half: with nothing to show and no add door, the empty state is
    // the honest answer, and its link out is the only thing left to offer.
    room([], false);
    expect(screen.queryByRole('button', { name: /Add repository/i })).toBeNull();
  });
});

describe('the PICKER’s list — fetched on OPEN, and every way that read can end', () => {
  it('is not fetched until the door is opened, then is', async () => {
    room([]);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(answer([OPTION('r1', 'moooon/motir-core')]));
    fireEvent.click(screen.getByRole('button', { name: /Add repository/i }));

    await waitFor(() => expect(screen.getByText('moooon/motir-core')).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/api/projects/ACME/repositories/available',
    );
  });

  it('a REFUSED read leaves the picker saying so, not empty', async () => {
    // An empty list and a failed read mean opposite things — "your organisation
    // has none left to add" versus "we could not find out" — and only one of them
    // is a reason to try again.
    room([]);
    fetchMock.mockResolvedValueOnce(answer(null, false));
    fireEvent.click(screen.getByRole('button', { name: /Add repository/i }));
    await waitFor(() =>
      expect(
        screen.getByText('Couldn’t load your organisation’s repositories. Try again.'),
      ).toBeTruthy(),
    );
  });

  it('a THROWN read is caught — the room does not crash on a dead network', async () => {
    // `loadOptions` catches, so the picker stays open carrying its error copy
    // rather than the room unmounting under a rejected promise.
    room([]);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: /Add repository/i }));
    await waitFor(() =>
      expect(
        screen.getByText('Couldn’t load your organisation’s repositories. Try again.'),
      ).toBeTruthy(),
    );
  });
});

describe('PICKING — both surfaces of the page-state contract', () => {
  async function openWithOne() {
    room([]);
    fetchMock.mockResolvedValueOnce(answer([OPTION('r1', 'moooon/motir-core')]));
    fireEvent.click(screen.getByRole('button', { name: /Add repository/i }));
    await waitFor(() => expect(screen.getByText('moooon/motir-core')).toBeTruthy());
  }

  it('inserts the row into THIS island AND refreshes the server header', async () => {
    await openWithOne();
    fetchMock.mockResolvedValueOnce(answer(ORG_ROW('new', 'motir-core')));

    fireEvent.click(screen.getByRole('button', { name: /motir-core/ }));

    // Surface 3 — the row the mutation returned, kept locally. `router.refresh()`
    // cannot reach a `useState`-seeded list, so without this the room would sit
    // there unchanged after a successful add.
    await waitFor(() => expect(screen.getByText('motir-core')).toBeTruthy());
    // Surface 2 — the server-rendered summary counts over BOTH registries and
    // would otherwise report the pre-add total beside a list that grew.
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    const add = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/repositories/add'))!;
    expect(JSON.parse(String((add[1] as RequestInit).body))).toMatchObject({ githubRepoId: 'r1' });
  });

  it('⚠️ a REFUSED add says so and adds NOTHING — no optimistic row survives it', async () => {
    // The failure that matters: an optimistic insert written before the response
    // would leave a repository on screen that the project does not hold.
    await openWithOne();
    fetchMock.mockResolvedValueOnce(answer(null, false));

    fireEvent.click(screen.getByRole('button', { name: /motir-core/ }));

    await waitFor(() => expect(screen.getByRole('alert', { hidden: true })).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('REMOVING from the project — the narrow one of the two removals', () => {
  it('drops the row locally and refreshes the header', async () => {
    room([ORG_ROW('r1', 'motir-core')]);
    fetchMock.mockResolvedValueOnce(answer({}, true));

    // ⚠️ THE NARROW REMOVAL STILL CONFIRMS. Both removals in this story are
    // behind a dialogue that says what each one does NOT do — the pair is only
    // legible if neither is one click.
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('motir-core')).toBeNull());
    expect(refresh).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/projects/ACME/repositories/r1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('⚠️ a REFUSED removal keeps the row — the list still says what the server says', async () => {
    room([ORG_ROW('r1', 'motir-core')]);
    fetchMock.mockResolvedValueOnce(answer(null, false));

    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.getByRole('alert', { hidden: true })).toBeTruthy());
    expect(screen.getByText('motir-core')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// ⚠️ THE ROOM DOES NOT DRAW A REPOSITORY MOTIR HOSTS AS THE ORGANISATION'S (bug
// MOTIR-4867).
//
// The seven-row fixture is the live MOTIR project on the day this was filed: no
// repository SET, and a workspace registry holding six repositories the
// organisation connected plus one Motir CREATED, which
// `githubRepoRepository.listByWorkspace` returns because it filters on
// `workspace_id` alone. The room drew all seven under `From your organisation`
// — "Repositories moooon is connected to" — and its header read
// `0 moving · 0 hosted by Motir · 7 yours`.
//
// ⚠️ AND IT IS THE CLASS, NOT THE ROW. The read is WORKSPACE-scoped, so any
// set-less project in a workspace where Motir hosts anything draws the other
// project's hosted repositories as its own. Deleting the one offending row on
// the one tenant would clear the screenshot and leave this test failing, which
// is the point of asserting the predicate rather than the tenant.
describe('a repository under the provisioning organisation, in the mounted room', () => {
  const HOST_OWNER = 'motir-projects';

  /** The six the organisation connected, plus the one Motir created — in the
   *  order `listByWorkspace` returns them, owner-then-name. */
  const SEVEN: ProjectRepoConnectedDto[] = [
    ...[
      'motir-ai',
      'motir-core',
      'motir-gateway',
      'motir-marketing',
      'motir-meta',
      'motir-www',
    ].map((name) => ({ name, repoRef: `moooon-B-V/${name}`, defaultBranch: 'main' })),
    { name: 'motir', repoRef: `${HOST_OWNER}/motir`, defaultBranch: 'main' },
  ];

  function layeredRoom(connected: ProjectRepoConnectedDto[]) {
    renderWithIntl(
      <RepositoriesRoom
        projectKey="ACME"
        view={{ ...view([]), connected, connectedInDomain: true, hostOwner: HOST_OWNER }}
        connectHref="/settings/account/git"
        canAddRepositories={false}
        organizationName="moooon"
        organizationInventoryHref="/settings/organization/git"
        nowIso="2026-09-08T12:00:00.000Z"
      />,
    );
  }

  it('⚠️ THE DEFECT, as one assertion: it is absent from `From your organisation`', () => {
    layeredRoom(SEVEN);
    const section = screen.getByRole('region', { name: 'From your organisation' });
    // The six the organisation really did connect are all there…
    expect(within(section).getAllByRole('listitem')).toHaveLength(6);
    expect(within(section).getByText('motir-core')).toBeTruthy();
    // …and the one Motir hosts is not, by NAME and by its owner prefix — the
    // prefix matters because `motir` is a substring of five of the six names.
    expect(within(section).queryByText('motir')).toBeNull();
    expect(within(section).queryByText(`${HOST_OWNER}/`)).toBeNull();
  });

  it('⚠️ and the summary over the same fixture does not read `7 yours`', () => {
    // The summary is rendered by the PAGE (a server component reading the same
    // room view), not by this island, so it is measured here through the very
    // function that page calls rather than by a second render of a server
    // component this test environment cannot mount. Same fixture, same
    // `hostOwner`, one assertion apart from the render above.
    expect(summarizeRepositories([], SEVEN, HOST_OWNER)).toEqual({
      moving: 0,
      hosted: 0,
      yours: 6,
    });
  });

  it('draws nothing at all for it — the hosted section is the project`s own ROWS', () => {
    // The disposition this card chose, asserted so a later widening has to
    // change a test rather than a rendering. `Hosted by Motir` holds
    // `project_repository` rows carrying the takeover saga; this project has
    // none, so the section is ABSENT rather than present-and-empty
    // (`design/repository-set/design-notes.md` §16.1).
    layeredRoom(SEVEN);
    expect(screen.queryByText('Hosted by Motir')).toBeNull();
  });

  it('⚠️ leaves a deployment that cannot provision byte-for-byte unchanged', () => {
    // `hostOwner: null` — self-hosted, no `GITHUB_FALLBACK_ORG`, nothing hosted.
    // All seven are the organisation's, exactly as before this rule existed.
    renderWithIntl(
      <RepositoriesRoom
        projectKey="ACME"
        view={{ ...view([]), connected: SEVEN, connectedInDomain: true, hostOwner: null }}
        connectHref="/settings/account/git"
        canAddRepositories={false}
        organizationName="moooon"
        organizationInventoryHref="/settings/organization/git"
        nowIso="2026-09-08T12:00:00.000Z"
      />,
    );
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(7);
  });
});

// THE PAGE'S OWN CONTRACT — which organisation the room is told to name
// (MOTIR-4801). The component above is handed `organizationName` as a prop and
// cannot be wrong about it; the page that computes the prop can, and did.
describe('the page names the PROJECT`s organisation, not the actor`s', () => {
  const PAGE = readFileSync('app/(authed)/settings/project/repositories/page.tsx', 'utf8');

  it('⚠️ resolves the organisation from the WORKSPACE, never from an actor-scoped read', () => {
    // `resolveActiveOrganization(userId, null)` falls through to the caller's
    // FIRST org membership in row order. It never sees the project, the
    // workspace or the org cookie — so for a member of two organisations the
    // section heading, the hint, the picker segment and the `See every
    // repository in <org>` link all named a tenant this project has nothing to
    // do with, and were accidentally right for everybody with one membership.
    expect(PAGE).toContain('resolveWorkspaceOrganization(userId, workspaceId)');
    expect(PAGE).not.toContain('resolveActiveOrganization(');
  });
});
