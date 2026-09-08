import { describe, expect, it } from 'vitest';
import {
  connectedNotInSet,
  splitRoomSections,
  summarizeRepositories,
} from '@/lib/projectRepos/roomSections';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type {
  ProjectRepoConnectedDto,
  ProjectRepoDto,
  ProjectRepoTakeoverStateDto,
} from '@/lib/dto/projectRepos';

/** The provisioning organisation, as `ProjectRepoRoomViewDto.hostOwner` carries
 *  it. Every call below passes it, because `splitRoomSections` /
 *  `summarizeRepositories` require it — a caller that cannot say who owns the
 *  layered repositories cannot compute the organisation's section. */
const HOST_OWNER = 'motir-projects';

// THE ROOM'S SECTION SPLIT (MOTIR-3126) — pure, so it is ruled on here rather than
// through a render.
//
// The two functions are applied on BOTH sides of the wire (the server seeds the
// room with them; the client island re-applies them on every refetch), so what is
// asserted is the rule itself: which side of the split a repository falls on, and
// what the header's counts are over.

describe('connectedNotInSet', () => {
  it('drops a connected repository a set row already names', () => {
    const out = connectedNotInSet(
      [row({ name: 'acme-web' })],
      [connected('acme-web'), connected('design-tokens')],
    );
    expect(out.map((r) => r.name)).toEqual(['design-tokens']);
  });

  it('matches case-insensitively — two spellings are ONE checkout identity', () => {
    // The rule `mergeDomainsByName` applies for dispatch. A row spelled one way
    // and an installation entry spelled another are the same repository, and
    // showing it twice is how a person concludes they have two.
    const out = connectedNotInSet([row({ name: 'Acme-Web' })], [connected('acme-web')]);
    expect(out).toEqual([]);
  });

  it('matches on the REALIZED name, which is what a checkout answers to', () => {
    // The host's casing wins over the row's authored name, exactly as
    // `toProjectRepoNames` prefers it: someone renamed the repository on GitHub
    // and the row kept the old intent.
    const out = connectedNotInSet(
      [row({ name: 'old-name', realized: 'acme-web' })],
      [connected('acme-web')],
    );
    expect(out).toEqual([]);
  });

  it('keeps a row that has NOT been realized from claiming a different name', () => {
    const out = connectedNotInSet([row({ name: 'acme-api' })], [connected('acme-web')]);
    expect(out.map((r) => r.name)).toEqual(['acme-web']);
  });

  it('de-duplicates the connected list against itself and preserves its order', () => {
    const out = connectedNotInSet(
      [],
      [connected('motir-core'), connected('motir-ai'), connected('MOTIR-CORE')],
    );
    expect(out.map((r) => r.name)).toEqual(['motir-core', 'motir-ai']);
  });
});

// ⚠️ THE ORG SECTION IS THE LADDER'S ANSWER (bug MOTIR-4820).
//
// The rule under the defect, ruled on here because it is pure. The section used
// to be `rows.filter(seedSource === 'organization')`, which on a set-less project
// is EMPTY — while `/settings/organization/git`, moved onto the ladder by
// MOTIR-4802, reported every one of that project's connected repositories as
// `Used by <project>`. The two surfaces answered one question two ways, and each
// was internally consistent, which is why neither page's own tests could see it.
describe('splitRoomSections', () => {
  it('puts the LAYERED repositories in the organisation section, beside the links', () => {
    const { fromOrganization } = splitRoomSections(
      [orgRow('picked')],
      [connected('layered')],
      true,
      HOST_OWNER,
    );
    expect(fromOrganization.map((e) => e.kind)).toEqual(['link', 'domain']);
    // LINKS FIRST, then the layered half — a stable order, and the same one the
    // organisation inventory composes its `Used by` list in.
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked', 'acme-inc/layered']);
  });

  it('⚠️ THE DEFECT, as one assertion: a set-less project`s section is NOT empty', () => {
    // Motir's own project on the day this was filed: no repository SET, seven
    // repositories connected to the organisation. The section headed `From your
    // organisation` drew empty above all seven.
    const { fromOrganization, motirHosted } = splitRoomSections(
      [],
      [connected('motir-core'), connected('motir-ai')],
      true,
      HOST_OWNER,
    );
    expect(fromOrganization.map((e) => e.kind)).toEqual(['domain', 'domain']);
    expect(motirHosted).toEqual([]);
  });

  it('⚠️ reads the LADDER`s boolean, never a count — a project answered by its set alone', () => {
    // The counterfactual that keeps `layersConnected` honest. A project born in
    // Motir is answered by its set completely, so nothing is layered even if the
    // caller hands over a non-empty list.
    const { fromOrganization } = splitRoomSections(
      [],
      [connected('motir-core')],
      false,
      HOST_OWNER,
    );
    expect(fromOrganization).toEqual([]);
  });

  it('keeps a Motir-HOSTED row out of the organisation section', () => {
    // `seedSource` still does this job, and only this job: it says which set rows
    // are links and which are rows Motir created. A hosted row in the org section
    // would lose its takeover, which is the only action it has.
    const { fromOrganization, motirHosted } = splitRoomSections(
      [row({ name: 'hosted' }), orgRow('picked')],
      [],
      true,
      HOST_OWNER,
    );
    expect(motirHosted.map((r) => r.id)).toEqual(['row-hosted']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('the split over the SET is total — no row is lost and none is duplicated', () => {
    const rows = [row({ name: 'a' }), orgRow('b'), row({ name: 'c' })];
    const { fromOrganization, motirHosted } = splitRoomSections(rows, [], true, HOST_OWNER);
    const links = fromOrganization.filter((e) => e.kind === 'link');
    expect(links.length + motirHosted.length).toBe(rows.length);
  });
});

describe('summarizeRepositories', () => {
  it('counts a connected repository as YOURS — it is', () => {
    // The header-level form of the defect: a summary read off the set alone
    // reports `0 yours` for a project holding four repositories of its own.
    expect(summarizeRepositories([], [connected('a'), connected('b')], HOST_OWNER)).toEqual({
      moving: 0,
      hosted: 0,
      yours: 2,
    });
  });

  it('counts the three ownerships separately — they are legal at once', () => {
    const counts = summarizeRepositories(
      [
        row({ name: 'hosted' }),
        row({ name: 'moving', takeover: 'transfer_pending' }),
        row({ name: 'taken', takeover: 'done' }),
        row({ name: 'brought', state: 'connected' }),
      ],
      [connected('own')],
      HOST_OWNER,
    );
    // One row moving must never make the whole project read as "moving".
    expect(counts).toEqual({ moving: 1, hosted: 1, yours: 3 });
  });

  it('does not count a FAILED takeover as moving — a refused request is not in flight', () => {
    expect(summarizeRepositories([row({ name: 'x', takeover: 'failed' })], [], HOST_OWNER)).toEqual(
      {
        moving: 0,
        hosted: 1,
        yours: 0,
      },
    );
  });
});

// ⚠️ A REPOSITORY MOTIR HOSTS IS NOT THE ORGANISATION'S, AND IT IS NOT `yours`
// (bug MOTIR-4867).
//
// `connected` is `githubRepoRepository.listByWorkspace`, filtered on
// `github_repo.workspace_id` and nothing else — the read that answers *can this
// workspace dispatch into it*, which MOTIR-1931 widened on purpose so a
// repository Motir CREATES for a workspace is a legal `targetRepo`. The room read
// it as *whose is it*, so a Motir-hosted repository the current project holds no
// `project_repository` row for was drawn under `From your organisation` and
// counted in `yours` — whose own promise is *the user owns it, Motir never bills
// its CI, and there is nothing to move*, all three inverted.
//
// Ruled on here because the classification is PURE and is applied on both sides
// of the wire: the server seeds the room with it, and the island re-applies it on
// every refetch. `hostOwner` is threaded in rather than read, so the two sides
// cannot answer it differently.
describe('a repository under the PROVISIONING organisation', () => {
  it('is not counted in `yours` — the summary`s own promise is false of it', () => {
    // AC1. Two layered repositories, one of each ownership, and nothing else on
    // the project. `yours` is the moooon-B-V one alone.
    const counts = summarizeRepositories(
      [],
      [hostedConnected('motir'), orgConnected('motir-core')],
      HOST_OWNER,
    );
    expect(counts).toEqual({ moving: 0, hosted: 0, yours: 1 });
  });

  it('is not an entry of `From your organisation` — moooon connected nothing there', () => {
    // AC2, the same input. The section holds the organisation's repository alone.
    const { fromOrganization } = splitRoomSections(
      [],
      [hostedConnected('motir'), orgConnected('motir-core')],
      true,
      HOST_OWNER,
    );
    expect(fromOrganization.map((e) => e.id)).toEqual(['moooon-B-V/motir-core']);
  });

  it('⚠️ does NOT move into the hosted COUNT — that section draws rows, and it has none', () => {
    // The half of the fix that is a decision rather than a subtraction. `hosted`
    // is the count of what `Hosted by Motir` DRAWS, and it draws
    // `project_repository` rows carrying the takeover saga. Counting a mirror row
    // with no link would put a number above a section that does not contain it —
    // and the section's hint promises a `Move to my GitHub` such a row cannot
    // offer.
    expect(summarizeRepositories([], [hostedConnected('motir')], HOST_OWNER)).toEqual({
      moving: 0,
      hosted: 0,
      yours: 0,
    });
  });

  it('matches the owner CASE-INSENSITIVELY — a GitHub login is, and the value is configuration', () => {
    // AC3, first half. `provisioningOrgLogin()` returns whatever an operator
    // typed into `GITHUB_FALLBACK_ORG`; the same comparison `isMotirOwnedRepo`
    // makes for the CI meter's §5.1 gate.
    const connectedRepos = [hostedConnected('motir', 'MOTIR-Projects')];
    expect(summarizeRepositories([], connectedRepos, 'motir-projects').yours).toBe(0);
    expect(splitRoomSections([], connectedRepos, true, 'motir-projects').fromOrganization).toEqual(
      [],
    );
  });

  it('⚠️ classifies NOTHING when `hostOwner` is null — a deployment that cannot provision hosts nothing', () => {
    // AC3, second half, and the counterfactual that keeps this rule from
    // narrowing a self-hosted deployment's room. With no `GITHUB_FALLBACK_ORG`
    // there is no provisioning org, so the classification is byte-for-byte what
    // it was before this rule existed: both entries are the organisation's.
    const connectedRepos = [hostedConnected('motir'), orgConnected('motir-core')];
    expect(summarizeRepositories([], connectedRepos, null)).toEqual({
      moving: 0,
      hosted: 0,
      yours: 2,
    });
    expect(
      splitRoomSections([], connectedRepos, true, null).fromOrganization.map((e) => e.id),
    ).toEqual(['motir-projects/motir', 'moooon-B-V/motir-core']);
  });

  it('reads the owner off `repoRef`, and degrades honestly on a ref with no owner', () => {
    // `ProjectRepoConnectedDto` carries no `owner` column — its own doc says why
    // — so the owner is the `repoRef` segment, cut the same way
    // `OrganizationRepositories.ownerPrefix` cuts it for the row a reader sees. A
    // ref that somehow holds no `/` is nobody's provisioning org, so it stays.
    const bare: ProjectRepoConnectedDto = {
      name: 'motir',
      repoRef: 'motir',
      defaultBranch: 'main',
    };
    expect(summarizeRepositories([], [bare], HOST_OWNER).yours).toBe(1);
  });
});

function connected(name: string): ProjectRepoConnectedDto {
  return { name, repoRef: `acme-inc/${name}`, defaultBranch: 'main' };
}

function row(opts: {
  name: string;
  realized?: string;
  state?: ProjectRepoDto['state'];
  takeover?: ProjectRepoTakeoverStateDto;
}): ProjectRepoDto {
  const realizedName = opts.realized ?? opts.name;
  return {
    id: `row-${opts.name}`,
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name: opts.name,
    seedSource: 'platform-starter',
    state: opts.state ?? 'created',
    failureReason: null,
    proposalSignal: null,
    realizedRepo: {
      id: `gh-${realizedName}`,
      provider: 'github',
      owner: 'motir-projects',
      name: realizedName,
      repoRef: `motir-projects/${realizedName}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: opts.takeover
      ? {
          state: opts.takeover,
          targetOwner: 'yue-personal',
          requestedAt: '2026-08-19T00:00:00.000Z',
          transferredAt: null,
          completedAt: null,
          failureReason: null,
        }
      : null,
    access: { state: 'accepted', login: 'yue-personal', invitationUrl: null },
    position: 'a0',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

/** A set row that arrived through the picker — a LINK to an organisation
 *  repository, which is what `seedSource` records and all it records. */
function orgRow(name: string): ProjectRepoDto {
  return { ...row({ name }), seedSource: SEED_SOURCE_ORGANIZATION };
}

/** A layered repository under the ORGANISATION — the ordinary case, and what the
 *  section is named for. */
function orgConnected(name: string): ProjectRepoConnectedDto {
  return { name, repoRef: `moooon-B-V/${name}`, defaultBranch: 'main' };
}

/** A layered repository under the PROVISIONING organisation — one MOTIR created,
 *  mirrored into this workspace's `github_repo` by `persistProvisionedRepo` so it
 *  is a legal `targetRepo` (MOTIR-1931), and reaching the room through the same
 *  workspace-scoped read. The owner is a PARAMETER so the case-insensitivity case
 *  can vary its spelling without hard-coding a login twice. */
function hostedConnected(name: string, owner: string = HOST_OWNER): ProjectRepoConnectedDto {
  return { name, repoRef: `${owner}/${name}`, defaultBranch: 'main' };
}
