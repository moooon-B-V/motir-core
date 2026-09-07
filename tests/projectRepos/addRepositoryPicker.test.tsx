// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AddRepositoryPicker } from '@/app/(authed)/settings/project/repositories/_components/AddRepositoryPicker';
import { OrganizationRepositories } from '@/app/(authed)/settings/project/repositories/_components/OrganizationRepositories';
import { splitRoomSections } from '@/lib/projectRepos/roomSections';
import { SEED_SOURCE_ORGANIZATION, defaultSeedSourceForRole } from '@/lib/projectRepos/vocabulary';
import type { OrgRepoOptionDto } from '@/lib/dto/organizationRepos';
import type { OrgSectionEntry } from '@/lib/projectRepos/roomSections';
import type { ProjectRepoConnectedDto, ProjectRepoDto } from '@/lib/dto/projectRepos';

// THE `Add repository` PICKER, and the section a picked repository lands in
// (Story MOTIR-4669 · MOTIR-4681), against
// `design/repository-set/design-notes.md` §17.2–17.6.
//
// The shapes this file exists to hold, each of which the design names as a thing
// that WILL otherwise be got wrong:
//
//   1. A FIRST-TIME ORGANISATION GETS A PICKER, not a signpost. An empty state
//      with a link out turns one intent into two errands — the same defect at the
//      project tier that the whole story removes at the organisation tier.
//   2. `already indexed · shared` is a STATE and carries the promise of the tier
//      move. Without it the row is indistinguishable from the segment below,
//      which is exactly the pair the reader is asked to tell apart.
//   3. THE SECTION SPLIT. A picked repository has a `project_repository` row, so
//      it would otherwise render as a Motir-hosted takeover row and offer
//      **Take it over** for a repository the organisation already owns.
//   4. THE TWO REMOVALS MUST NOT LOOK ALIKE.

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

const ROW = (id: string, seedSource: string, name = 'motir-core'): ProjectRepoDto =>
  ({
    id,
    projectId: 'p1',
    role: 'api',
    label: null,
    name,
    seedSource,
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

afterEach(cleanup);

function renderPicker(over: Partial<Parameters<typeof AddRepositoryPicker>[0]> = {}) {
  const onPick = vi.fn().mockResolvedValue(undefined);
  renderWithIntl(
    <AddRepositoryPicker
      options={[OPTION('r1', 'moooon/motir-core'), OPTION('r2', 'moooon/motir-ai')]}
      alreadyHeld={[]}
      organizationName="moooon"
      installHref="https://github.com/apps/motir/installations/new"
      loading={false}
      error={false}
      open
      onOpenChange={vi.fn()}
      onPick={onPick}
      {...over}
    />,
  );
  return { onPick };
}

describe('the picker — ONE list, TWO segments', () => {
  it('renders both segment headings and the organisation`s repositories', () => {
    renderPicker();
    expect(screen.getByText('In moooon · already connected')).toBeTruthy();
    expect(screen.getByText('Connect a new one')).toBeTruthy();
    expect(screen.getByText('moooon/motir-core')).toBeTruthy();
    expect(screen.getByText('moooon/motir-ai')).toBeTruthy();
  });

  it('⚠️ every pickable row carries `already indexed · shared`', () => {
    // The chip is the whole promise of the tier move: the graph exists, belongs to
    // the organisation, and is not rebuilt because a second project picked it up.
    renderPicker();
    expect(screen.getAllByText('already indexed · shared')).toHaveLength(2);
  });

  it('picking calls through with the option, and does not navigate', async () => {
    const { onPick } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: /motir-core/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: 'r1' });
  });

  it('a repository this project ALREADY has is listed and unpickable, not filtered out', () => {
    // A reader who came looking for it should find it and see why it is not
    // offered. Filtering it away answers a different question than the one they
    // asked.
    renderPicker({ alreadyHeld: [OPTION('r9', 'moooon/design-system')] });
    expect(screen.getByText('moooon/design-system')).toBeTruthy();
    expect(screen.getByText('already in this project')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /design-system/ })).toBeNull();
  });
});

describe('⚠️ a FIRST-TIME organisation is a PICKER, not a signpost', () => {
  // §17.4, the specific shape this amendment exists to forbid: "Nothing to pick"
  // must never render as a message whose job is to send somebody to another page.

  it('renders ONE segment, and it is the connect one', () => {
    renderPicker({ options: [], alreadyHeld: [] });
    expect(screen.queryByText(/already connected/)).toBeNull();
    expect(screen.getByText('Connect a new one')).toBeTruthy();
  });

  it('says what will HAPPEN, rather than sending anyone away', () => {
    renderPicker({ options: [], alreadyHeld: [] });
    expect(
      screen.getByText(
        'Connect the first one and it lands in moooon and in this project at the same time.',
      ),
    ).toBeTruthy();
  });

  it('drops the SEARCH field — there is nothing to search', () => {
    renderPicker({ options: [], alreadyHeld: [] });
    expect(screen.queryByLabelText('Search repositories')).toBeNull();
  });

  it('and the connect action is the PRIMARY here, a secondary elsewhere', () => {
    // The zero case's one action leads; with a list above it, it is the quieter of
    // two paths because the free one is the common one.
    renderPicker({ options: [], alreadyHeld: [], installHref: 'https://example.test/install' });
    // The Modal renders through a PORTAL, so the link is in the document rather
    // than in the render's own container.
    const zeroLink = document.querySelector('a[href="https://example.test/install"]');
    expect(zeroLink?.className).toContain('--el-accent');

    cleanup();

    // …and with a list above it, the same control is the quieter of two paths.
    renderPicker({ installHref: 'https://example.test/install' });
    const withList = document.querySelector('a[href="https://example.test/install"]');
    expect(withList?.className).not.toContain('bg-(--el-accent)');
  });

  it('⚠️ a search that matches NOTHING still has two segments, and says so', () => {
    // The zero case is about the ORGANISATION, not about the query. Collapsing to
    // one segment on an empty search would tell a reader their organisation has
    // nothing, which is a different and false claim.
    renderPicker({ options: [], alreadyHeld: [OPTION('r9', 'moooon/held')] });
    expect(screen.getByText(/already connected/)).toBeTruthy();
  });
});

/** A connected repository as the room's domain read carries it. */
const CONNECTED = (
  name: string,
  owner = 'moooon',
  branch: string | null = 'main',
): ProjectRepoConnectedDto => ({
  name,
  repoRef: owner ? `${owner}/${name}` : name,
  defaultBranch: branch,
});

/** The two halves of the org section, as `splitRoomSections` hands them over. */
const LINK = (row: ProjectRepoDto): OrgSectionEntry => ({ kind: 'link', id: row.id, row });
const DOMAIN = (repo: ProjectRepoConnectedDto): OrgSectionEntry => ({
  kind: 'domain',
  id: repo.repoRef,
  repo,
});

describe('the picker`s honest states', () => {
  it('reports a failed load rather than an empty organisation', () => {
    renderPicker({ options: [], alreadyHeld: [], error: true });
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load');
    // …and it does NOT collapse to the one-segment zero case, which would claim
    // the organisation has nothing when the truth is that nobody knows.
    expect(screen.queryByText(/lands in moooon/)).toBeNull();
  });

  it('drops the connect control on a deployment with no App, rather than linking nowhere', () => {
    renderPicker({ installHref: null });
    expect(screen.getByText(/isn’t available on this deployment/)).toBeTruthy();
  });
});

describe('⚠️ THE SECTION SPLIT — a picked repository is not Motir-hosted', () => {
  it('splits on the row`s own seedSource, and the split is TOTAL', () => {
    const picked = ROW('a', SEED_SOURCE_ORGANIZATION);
    const hosted = ROW('b', defaultSeedSourceForRole('api'), 'acme-api');
    const { fromOrganization, motirHosted } = splitRoomSections([picked, hosted], [], false);

    expect(fromOrganization.map((e) => e.id)).toEqual(['a']);
    expect(motirHosted.map((r) => r.id)).toEqual(['b']);
    // Every row falls on exactly one side — so a row cannot be lost by a future
    // third arm arriving without its own branch.
    expect(fromOrganization.length + motirHosted.length).toBe(2);
  });

  it('a WEB row Motir would scaffold is not mistaken for an organisation one', () => {
    // The counterfactual for the discriminator: `web` takes a different default
    // seed source from every other role, so a split that keyed on "not
    // initialised" would put it on the wrong side.
    const web = ROW('c', defaultSeedSourceForRole('web'), 'acme');
    expect(splitRoomSections([web], [], false).motirHosted.map((r) => r.id)).toEqual(['c']);
  });
});

describe('the ORGANISATION section, and its ONE action', () => {
  function renderSection(over: Partial<Parameters<typeof OrganizationRepositories>[0]> = {}) {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <OrganizationRepositories
        entries={[LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]}
        organizationName="moooon"
        inventoryHref="/settings/organization/git"
        canAdd
        onRemove={onRemove}
        addButton={<button type="button">Add repository</button>}
        {...over}
      />,
    );
    return { onRemove };
  }

  it('is headed `From your organisation`, not `Your own repositories`', () => {
    // The old copy was true of a workspace-connected repository and is FALSE of an
    // org-owned one: these are not the reader's personally.
    renderSection();
    expect(screen.getByText('From your organisation')).toBeTruthy();
  });

  it('the footer link is a VIEW, not a hand-off — the tier move in one line', () => {
    renderSection();
    const link = screen.getByRole('link', { name: 'See every repository in moooon' });
    expect(link.getAttribute('href')).toBe('/settings/organization/git');
  });

  it('⚠️ without permission the add door is ABSENT and a sentence says who can', () => {
    // Not disabled — an entry point is a promise about a room. Not silent either —
    // a room whose one action vanishes leaves a reader wondering whether they are
    // looking at a bug.
    renderSection({ canAdd: false });
    expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
    expect(screen.getByText(/Only owners and admins of your organisation can add/)).toBeTruthy();
  });

  it('⚠️ the REMOVE action is NOT gated on that permission', () => {
    // The discriminator is what the act CHANGES: one `ProjectRepo` row, and
    // neither the organisation's connection nor the code graph. The room's own
    // scope takes the room's own permission.
    renderSection({ canAdd: false });
    expect(screen.getByRole('button', { name: 'Remove from this project' })).toBeTruthy();
  });
});

describe('⚠️ the two removals do not look alike', () => {
  it('the label names its OWN tier', async () => {
    // So neither depends on the reader knowing which page they are standing on.
    renderWithIntl(
      <OrganizationRepositories
        entries={[LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]}
        organizationName="moooon"
        inventoryHref="/settings/organization/git"
        canAdd
        onRemove={vi.fn()}
        addButton={null}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove from this project' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it('the confirm REASSURES — its copy spends its length on what does NOT happen', async () => {
    renderWithIntl(
      <OrganizationRepositories
        entries={[LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]}
        organizationName="moooon"
        inventoryHref="/settings/organization/git"
        canAdd
        onRemove={vi.fn()}
        addButton={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));

    const body = await screen.findByText(/It stays connected to moooon/);
    expect(body.textContent).toContain('other projects keep it');
    expect(body.textContent).toContain('code index is untouched');
    // …and it makes NO retention promise, because nothing is being retained.
    expect(body.textContent).not.toMatch(/\b30\b|days/);
  });

  it('its primary is a SECONDARY button — a danger fill would claim a blast radius it does not have', async () => {
    const { container } = renderWithIntl(
      <OrganizationRepositories
        entries={[LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]}
        organizationName="moooon"
        inventoryHref="/settings/organization/git"
        canAdd
        onRemove={vi.fn()}
        addButton={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    await screen.findByText(/It stays connected to moooon/);

    const confirm = screen.getByRole('button', { name: 'Remove' });
    expect(confirm.className).not.toContain('bg-(--el-danger)');
    expect(container.querySelector('[class*="--el-danger-text"]')).toBeNull();
  });
});

// ⚠️ THE SECTION ANSWERS THE LADDER, NOT THE LINK TABLE (bug MOTIR-4820).
//
// MOTIR-4681 shipped `From your organisation` fed by `seedSource` alone, so on a
// project with no repository SET it drew EMPTY — directly above the very
// repositories it is about, which rendered under the old `Your own repositories`
// heading. `/settings/organization/git` had meanwhile moved onto the ladder
// (MOTIR-4802) and read `Used by <project>` for each of them. Two surfaces, one
// question, opposite answers.
//
// The section now takes BOTH halves of the ladder's answer as one list, and the
// only thing that distinguishes a member is whether there is a LINK to remove.
describe('⚠️ the org section holds the LADDER`s answer (MOTIR-4820)', () => {
  function renderEntries(entries: OrgSectionEntry[], canAdd = true) {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <OrganizationRepositories
        entries={entries}
        organizationName="moooon"
        inventoryHref="/settings/organization/git"
        canAdd={canAdd}
        onRemove={onRemove}
        addButton={<button type="button">Add repository</button>}
      />,
    );
    return { onRemove };
  }

  it('renders a LADDER-LAYERED repository the project has no row for', () => {
    // The defect in one assertion: this repository is the organisation's, the
    // project works on it, and the section headed `From your organisation` used
    // to be empty while it rendered thirty pixels lower under another name.
    renderEntries([DOMAIN(CONNECTED('motir-core'))]);
    expect(screen.getByText('From your organisation')).toBeTruthy();
    expect(screen.getByText('motir-core')).toBeTruthy();
    expect(screen.getByText('moooon/')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('⚠️ and gives it NO remove action — there is no link to delete', () => {
    // §16.2's rule, kept exactly: an affordance here would be a promise this room
    // cannot keep. A layered repository has no `project_repository` row, so a
    // `Remove from this project` would have nothing to remove.
    renderEntries([DOMAIN(CONNECTED('motir-core'))]);
    expect(screen.queryByRole('button', { name: 'Remove from this project' })).toBeNull();
  });

  it('renders LINKS and LAYERED repositories in ONE list, with the action on the link alone', () => {
    renderEntries([
      LINK(ROW('a', SEED_SOURCE_ORGANIZATION, 'picked')),
      DOMAIN(CONNECTED('layered')),
    ]);

    expect(screen.getByText('picked')).toBeTruthy();
    expect(screen.getByText('layered')).toBeTruthy();
    // ONE remove button, on the row that has something to remove.
    expect(screen.getAllByRole('button', { name: 'Remove from this project' })).toHaveLength(1);
  });

  it('⚠️ the footer says whose repositories these are — the tier the old copy got wrong', () => {
    // The absorbed section carried "Connected for the whole workspace, not for
    // this project alone": true of a workspace and wrong since MOTIR-4649 moved a
    // repository's tenancy to the ORGANISATION. It matters more here than it did
    // there, because this section now holds rows the project cannot remove.
    renderEntries([DOMAIN(CONNECTED('motir-core'))]);
    expect(
      screen.getByText('Connected to the organisation, not to this project alone.'),
    ).toBeTruthy();
    expect(screen.queryByText(/whole workspace/)).toBeNull();
  });

  it('degrades honestly on a repository with no branch and on a ref with no owner', () => {
    // Both are absences rather than states to hide: no guessed `main`, and never
    // a stray slash.
    renderEntries([
      DOMAIN(CONNECTED('no-branch', 'moooon', null)),
      DOMAIN(CONNECTED('bare-ref', '', 'trunk')),
    ]);
    expect(screen.getByText('no-branch')).toBeTruthy();
    expect(screen.queryByText('main')).toBeNull();
    expect(screen.getByText('bare-ref')).toBeTruthy();
    expect(screen.getByText('trunk')).toBeTruthy();
    expect(screen.queryByText('/')).toBeNull();
  });

  it('a LINK that has not realized its repository prints its authored name alone', () => {
    // The realized repository is preferred where there is one — the host's casing
    // is what a checkout answers to — and a row that has not realized one yet has
    // no owner to print.
    const row = { ...ROW('a', SEED_SOURCE_ORGANIZATION, 'planned'), realizedRepo: null };
    renderEntries([LINK(row as unknown as ProjectRepoDto)]);
    expect(screen.getByText('planned')).toBeTruthy();
    expect(screen.queryByText('moooon/')).toBeNull();
  });

  it('the confirm names the AUTHORED name when there is no realized repository', () => {
    const row = { ...ROW('a', SEED_SOURCE_ORGANIZATION, 'planned'), realizedRepo: null };
    renderEntries([LINK(row as unknown as ProjectRepoDto)]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    expect(screen.getByText(/Remove planned from this project\?/)).toBeTruthy();
  });

  it('removing a LINK calls back and closes the confirm', async () => {
    const { onRemove } = renderEntries([LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
  });

  it('cancelling closes the confirm and removes nothing', async () => {
    const { onRemove } = renderEntries([LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
    expect(onRemove).not.toHaveBeenCalled();
  });
});
