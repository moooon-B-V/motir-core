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
  // Bug MOTIR-4892 — the picker's segment offers the ORGANISATION's repositories,
  // and these fixtures are all of that kind.
  hostedByMotir: false,
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
      projectName="Motir"
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
  });

  it('⚠️ AC 1 — ONE link renders exactly ONE ROW, counted, not merely present', () => {
    // The count is the assertion, deliberately. Asserting the link is PRESENT
    // passed for the whole life of the defect: `moooon-B-V/motir-core` was
    // present twice on a project holding one repository — once as its link
    // carrying `Remove from this project`, once as a layered entry carrying
    // nothing — beneath a summary describing an organisation-sized list (§18.2).
    // A presence check cannot see a duplicate, and a duplicate was the symptom.
    room([ORG_ROW('r1', 'motir-core')]);
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(1);
  });

  it('⚠️ AC 8 — the inventory route is a NAMED LANDMARK after the sections, not a footnote', () => {
    // Design §18.6. It is the ONLY route from a project context to the
    // organisation's whole inventory now, so it is navigation with its own
    // accessible name — the third landmark on a page with two named sections, and
    // findable by a reader moving by landmark without reading either list.
    room([ORG_ROW('r1', 'motir-core')]);
    const nav = screen.getByRole('navigation', { name: 'Organisation repository inventory' });
    expect(
      within(nav).getByText(/Looking for a repository that is not linked to Motir\?/),
    ).toBeTruthy();
    const link = within(nav).getByRole('link', { name: 'See every repository in moooon' });
    expect(link.getAttribute('href')).toBe('/settings/organization/git');
  });

  it('⚠️ AC 8 — and it is NOT inside the organisation section it used to sit under', () => {
    // The half that catches a re-introduction: §18.6 says what the link is not —
    // provenance for the rows above it, or a disclosure that expands organisation
    // rows back onto this page. Inside that section it reads as the first; this
    // card removed the second.
    room([ORG_ROW('r1', 'motir-core')]);
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).queryByRole('link', { name: /See every repository/ })).toBeNull();
  });

  it('⚠️ AC 1 — zero links draws Panel 9, and the summary route out is still there', () => {
    // Not an error and not an empty box: the state EVERY project in the estate is
    // in today. It says the PROJECT is empty while the organisation may not be.
    room([]);
    expect(screen.getByText(/No repositories in this project yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add repository/i })).toBeTruthy();
    expect(
      screen.getByRole('navigation', { name: 'Organisation repository inventory' }),
    ).toBeTruthy();
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
describe('⚠️ AC 2 — the ORGANISATION`s inventory never reaches a row of this page', () => {
  const HOST_OWNER = 'motir-projects';

  /** The six the organisation connected, plus the one Motir created — in the
   *  order `listByWorkspace` returns them, owner-then-name. This is the exact
   *  fixture MOTIR-4867 was filed against, kept because the point has inverted
   *  rather than gone away: it used to prove that ONE of the seven was
   *  mis-classified into the section, and it now proves that NONE of the seven
   *  reaches it. */
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

  /** A room whose SERVER VIEW still carries the layered registry and still says
   *  the ladder layers it. That is deliberate and is the whole strength of these
   *  cases: `projectRepoRoomService` on `main` ships both fields today, and
   *  MOTIR-4955's open pull request is what empties them. This card must make the
   *  page correct WITHOUT that change, so the fixture keeps the fields populated
   *  and asserts nothing renders from them. It also means these cases keep
   *  passing after MOTIR-4955 lands, when the fields go empty for real. */
  function layeredRoom(connected: ProjectRepoConnectedDto[], rows: ProjectRepoDto[] = []) {
    renderWithIntl(
      <RepositoriesRoom
        projectKey="ACME"
        view={{ ...view(rows), connected, connectedInDomain: true, hostOwner: HOST_OWNER }}
        connectHref="/settings/account/git"
        // ⚠️ TRUE, so the ROOM renders rather than the whole-page signpost. With
        // no links AND no add door the room correctly collapses to the empty
        // state — which is a different assertion, made in the describe above.
        // What these cases are about is the SECTION: given a server view that
        // still carries seven layered repositories, how many rows does it draw?
        canAddRepositories
        organizationName="moooon"
        projectName="Motir"
        organizationInventoryHref="/settings/organization/git"
        nowIso="2026-09-08T12:00:00.000Z"
      />,
    );
  }

  it('⚠️ THE DEFECT, INVERTED: a project holding ONE link draws ONE row, not seven', () => {
    // §18.2, observed against the running app: one link, seven rows, and
    // `moooon-B-V/motir-core` drawn twice. The server view here still says all
    // seven are layered; exactly one is this project's.
    layeredRoom(SEVEN, [ORG_ROW('r1', 'motir-core')]);
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(1);
  });

  it('⚠️ AND THE SURVIVING TWIN IS GONE — the duplicate had no dedup to escape', () => {
    // The card's own instruction: fix the duplicate by removing its CAUSE, not by
    // hardening `connectedNotInSet`. The server already applied that dedup and the
    // twin came from the island's post-mutation recompute. With no second list
    // there is nothing left to de-duplicate against, so the name appears once by
    // construction rather than by a rule that can be got wrong again.
    layeredRoom(SEVEN, [ORG_ROW('r1', 'motir-core')]);
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).getAllByText('motir-core')).toHaveLength(1);
  });

  it('⚠️ a project with NO links draws no organisation row at all', () => {
    // The state that produced `0 moving · 0 hosted by Motir · 6 yours` above a
    // list of six repositories the project had never added.
    layeredRoom(SEVEN);
    expect(screen.getByText(/No repositories in this project yet/)).toBeTruthy();
    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('⚠️ and the summary over the same fixture reads three ZEROES, not `6 yours`', () => {
    // The summary is rendered by the PAGE (a server component reading the same
    // room view), not by this island, so it is measured through the very function
    // that page calls rather than by a second render this environment cannot
    // mount. Same fixture as the render above.
    expect(summarizeRepositories([])).toEqual({ moving: 0, hosted: 0, yours: 0 });
  });

  it('draws nothing at all for a hosted repository the project has no ROW for', () => {
    // `Hosted by Motir` holds `project_repository` rows carrying the takeover
    // saga; this project has none, so the section is ABSENT rather than
    // present-and-empty (`design/repository-set/design-notes.md` §16.1).
    layeredRoom(SEVEN);
    expect(screen.queryByText('Hosted by Motir')).toBeNull();
    expect(screen.queryByText(`${HOST_OWNER}/`)).toBeNull();
  });

  it('⚠️ `hostOwner` and `connectedInDomain` change NOTHING now — the page stopped asking', () => {
    // MOTIR-4867's fix was a CLASSIFICATION: subtract Motir's own repositories
    // from the layered half before drawing it. This card is the stronger form of
    // the same fix — the page does not draw a layered half, so there is no
    // half to classify and no way for the two sides of the wire to disagree
    // about it. Asserted by varying BOTH inputs across their whole range and
    // getting one answer.
    for (const hostOwner of [HOST_OWNER, null]) {
      for (const connectedInDomain of [true, false]) {
        renderWithIntl(
          <RepositoriesRoom
            projectKey="ACME"
            view={{ ...view([]), connected: SEVEN, connectedInDomain, hostOwner }}
            connectHref="/settings/account/git"
            canAddRepositories
            organizationName="moooon"
            projectName="Motir"
            organizationInventoryHref="/settings/organization/git"
            nowIso="2026-09-08T12:00:00.000Z"
          />,
        );
        const section = screen.getByRole('region', { name: 'From your organisation' });
        expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
        cleanup();
      }
    }
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
