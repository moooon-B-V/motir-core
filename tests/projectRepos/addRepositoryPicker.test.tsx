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
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

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
  // Bug MOTIR-4892 — the picker's segment offers the ORGANISATION's repositories,
  // and these fixtures are all of that kind.
  hostedByMotir: false,
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
      projectName="Motir"
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

  it('says what will HAPPEN, rather than sending anyone away — and NAMES both tiers', () => {
    // ⚠️ RE-POINTED BY MOTIR-4954 (design §18.5). The sentence used to open on
    // "Connect the first one" and end on "in this project", leaving the reader to
    // supply both the state they are in and the name of the thing they are being
    // promised. It now states the state ("{org} has no repositories connected
    // yet") and names the PROJECT, because connect-and-link's whole point is that
    // one action settles both tiers — and a promise about two tiers that names one
    // of them reads as a promise about one.
    renderPicker({ options: [], alreadyHeld: [] });
    expect(
      screen.getByText(
        'moooon has no repositories connected yet. Connect the first one and it lands in moooon and in Motir at the same time.',
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

// ⚠️ `CONNECTED` AND `HOST_OWNER` LIVED HERE AND ARE GONE (MOTIR-4954). They
// built a `ProjectRepoConnectedDto` — a repository the LADDER layers into the
// project with no `project_repository` row — and named the provisioning
// organisation that classified one. Both were arguments to `splitRoomSections`,
// which now takes the project's rows alone, so neither has anything to be an
// argument to. They are removed rather than left with an underscore: an unused
// fixture for a shape the type system no longer admits is an invitation to
// re-derive the section this card removed.

/** The org section's rows, as `splitRoomSections` hands them over.
 *  ⚠️ MOTIR-4954: there used to be a second constructor here, `DOMAIN`, for a
 *  ladder-layered repository with no `project_repository` row. That half of the
 *  union is gone — a project-scoped page draws links — so this is the whole of
 *  what the section can be handed. */
const LINK = (row: ProjectRepoDto): OrgSectionEntry => ({ kind: 'link', id: row.id, row });

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
    const { fromOrganization, motirHosted } = splitRoomSections([picked, hosted]);

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
    expect(splitRoomSections([web]).motirHosted.map((r) => r.id)).toEqual(['c']);
  });
});

describe('the ORGANISATION section, and its ONE action', () => {
  function renderSection(over: Partial<Parameters<typeof OrganizationRepositories>[0]> = {}) {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <OrganizationRepositories
        entries={[LINK(ROW('a', SEED_SOURCE_ORGANIZATION))]}
        organizationName="moooon"
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

  it('⚠️ NO LONGER CARRIES THE INVENTORY LINK — it is NAVIGATION now (MOTIR-4954)', () => {
    // Re-pointed. This used to assert the footer link is a VIEW rather than a
    // hand-off — the tier move in one line, and still true of the link. What
    // changed is WHERE it lives: `See every repository in {org}` moved out of this
    // card's footer into the room's own navigation block after both project
    // sections (design §18.6), because it is the ONLY route from a project context
    // to the organisation's inventory and a route is not a footnote to a list.
    // Asserted from BOTH sides — absent here, present there — so a re-introduction
    // in either place is caught. The nav block's own case is in
    // `repositoriesRoomOrgSection.test.tsx`.
    renderSection();
    expect(screen.queryByRole('link', { name: 'See every repository in moooon' })).toBeNull();
  });

  it('⚠️ NOR THE PROVENANCE SENTENCE — it is RETIRED, not relocated (MOTIR-4954)', () => {
    // "Connected to the organisation, not to this project alone" existed to
    // explain rows this section could not remove. There are none: every entry is
    // a link this project chose and may drop. A sentence that outlives the thing
    // it explained becomes the contradiction it was written to resolve — and it
    // was one half of exactly the pair §18.5 replaces.
    renderSection();
    expect(screen.queryByText(/not to this project alone/)).toBeNull();
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

// ⚠️ THE SECTION HOLDS THE PROJECT'S LINKS (MOTIR-4820, RE-POINTED BY MOTIR-4954).
//
// MOTIR-4681 shipped `From your organisation` fed by `seedSource` alone, so on a
// project with no repository SET it drew EMPTY — directly above the very
// repositories it is about, which rendered under the old `Your own repositories`
// heading. MOTIR-4820 fixed that by feeding the section the LADDER's answer:
// links plus everything layered, as one list.
//
// ⚠️ THAT FIX IS WHAT THIS CARD REVERSES, AND NOT BECAUSE IT WAS WRONG. It made
// the room and the organisation inventory agree, which they did not. What it also
// did was put the ORGANISATION's whole inventory on a PROJECT page: one project
// holding a single link rendered seven rows, `moooon-B-V/motir-core` drawn twice,
// and every control on the page operating on the link set while most rows were
// entries no control could touch (§18.2). The agreement is kept a different way —
// the room asks *what does this project work on?* and the inventory asks *what can
// it reach?*, which are different questions with a containment between them.
//
// So these cases are re-pointed rather than deleted: each one that asserted a
// layered entry RENDERS now asserts it CANNOT, at the type level and at the
// render.
describe('⚠️ the org section holds the PROJECT`s links (MOTIR-4820 → MOTIR-4954)', () => {
  function renderEntries(entries: OrgSectionEntry[], canAdd = true) {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <OrganizationRepositories
        entries={entries}
        organizationName="moooon"
        canAdd={canAdd}
        onRemove={onRemove}
        addButton={<button type="button">Add repository</button>}
      />,
    );
    return { onRemove };
  }

  it('⚠️ NOW HOLDS THE INVERSE: a LAYERED repository cannot be handed to this section at all', () => {
    // The strongest form this assertion can take, and the reason it is worth more
    // than a render check: `OrgSectionEntry` is a ONE-MEMBER union now, so the
    // `{ kind: 'domain', repo }` shape the three deleted cases constructed is a
    // TYPE ERROR rather than a row that fails to appear. What is asserted at
    // runtime is the consequence — every row the section draws carries the remove
    // action, because every row is a link.
    renderEntries([LINK(ROW('a', SEED_SOURCE_ORGANIZATION, 'picked'))]);
    expect(screen.getByText('picked')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove from this project' })).toHaveLength(1);
  });

  it('⚠️ EVERY row carries the remove action — the state is no longer carried by an affordance', () => {
    // §18.2's finding: the presence of `Remove from this project` was the ONLY
    // signal telling a repository the project works on from one it merely could
    // reach, and nothing labelled, grouped or ordered the two apart. With one kind
    // of row the affordance stops carrying a state it never named.
    renderEntries([
      LINK(ROW('a', SEED_SOURCE_ORGANIZATION, 'one')),
      LINK(ROW('b', SEED_SOURCE_ORGANIZATION, 'two')),
    ]);
    expect(screen.getAllByRole('button', { name: 'Remove from this project' })).toHaveLength(2);
  });

  it('⚠️ ZERO links is Panel 9 — a drawn starting condition, not an empty box', () => {
    // Every project in the estate is in this state today. It says the PROJECT is
    // empty while the organisation may not be, and it points at the add door
    // above rather than at another page.
    renderEntries([]);
    expect(screen.getByText(/No repositories in this project yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy();
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
