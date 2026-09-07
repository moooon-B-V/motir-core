// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AddRepositoryPicker } from '@/app/(authed)/settings/project/repositories/_components/AddRepositoryPicker';
import { OrganizationRepositories } from '@/app/(authed)/settings/project/repositories/_components/OrganizationRepositories';
import { splitSetRowsByOrigin } from '@/lib/projectRepos/roomSections';
import { SEED_SOURCE_ORGANIZATION, defaultSeedSourceForRole } from '@/lib/projectRepos/vocabulary';
import type { OrgRepoOptionDto } from '@/lib/dto/organizationRepos';
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
    const { fromOrganization, motirHosted } = splitSetRowsByOrigin([picked, hosted]);

    expect(fromOrganization.map((r) => r.id)).toEqual(['a']);
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
    expect(splitSetRowsByOrigin([web]).motirHosted.map((r) => r.id)).toEqual(['c']);
  });
});

describe('the ORGANISATION section, and its ONE action', () => {
  function renderSection(over: Partial<Parameters<typeof OrganizationRepositories>[0]> = {}) {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <OrganizationRepositories
        rows={[ROW('a', SEED_SOURCE_ORGANIZATION)]}
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
        rows={[ROW('a', SEED_SOURCE_ORGANIZATION)]}
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
        rows={[ROW('a', SEED_SOURCE_ORGANIZATION)]}
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
        rows={[ROW('a', SEED_SOURCE_ORGANIZATION)]}
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
