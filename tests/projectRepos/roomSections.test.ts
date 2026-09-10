import { describe, expect, it } from 'vitest';
import {
  connectedNotInSet,
  organizationConnected,
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
 *  it. ⚠️ MOTIR-4954: `splitRoomSections` and `summarizeRepositories` no longer
 *  take it — they read the project's links, whose ownership is on the row — so it
 *  is passed only to `organizationConnected`, the predicate that still classifies
 *  a LAYERED repository for the callers outside this room. */
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
  // ⚠️ RE-POINTED BY MOTIR-4954. These cases used to assert that a LAYERED
  // repository lands in the organisation section beside the links, that a
  // set-less project's section is therefore not empty, and that the ladder's own
  // boolean — never a count — decides whether layering happens at all. All three
  // were true of the merged shape and all three are now the opposite of the
  // product's contract: a project-scoped page draws the project's LINKS. So they
  // are re-pointed at the new rule rather than deleted, and each says what it now
  // holds.

  it('⚠️ NOW HOLDS THE INVERSE: a set-less project`s section is EMPTY, and that is the card', () => {
    // The exact fixture the old `⚠️ THE DEFECT` case used — Motir's own project
    // on the day MOTIR-4820 was filed: no repository SET, repositories connected
    // to the organisation. That card made the section draw all of them; this one
    // makes it draw none, because they are not this project's.
    //
    // ⚠️ AND THE CONNECTED LIST IS NOT AN ARGUMENT ANY MORE, which is the
    // strongest form this assertion can take: there is no parameter through which
    // an organisation repository could reach this page's rows.
    const { fromOrganization, motirHosted } = splitRoomSections([]);
    expect(fromOrganization).toEqual([]);
    expect(motirHosted).toEqual([]);
  });

  it('draws a LINK, and every entry it draws is one', () => {
    const { fromOrganization } = splitRoomSections([orgRow('picked')]);
    expect(fromOrganization.map((e) => e.kind)).toEqual(['link']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('keeps a Motir-HOSTED row out of the organisation section', () => {
    // `seedSource` still does this job, and now it is the ONLY job the split
    // consults: it says which set rows are links and which are rows Motir
    // created. A hosted row in the org section would lose its takeover, which is
    // the only action it has.
    const { fromOrganization, motirHosted } = splitRoomSections([
      row({ name: 'hosted' }),
      orgRow('picked'),
    ]);
    expect(motirHosted.map((r) => r.id)).toEqual(['row-hosted']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('the split over the SET is total — no row is lost and none is duplicated', () => {
    const rows = [row({ name: 'a' }), orgRow('b'), row({ name: 'c' })];
    const { fromOrganization, motirHosted } = splitRoomSections(rows);
    expect(fromOrganization.length + motirHosted.length).toBe(rows.length);
  });
});

describe('summarizeRepositories', () => {
  // ⚠️ RE-POINTED BY MOTIR-4954. The old first case asserted that a connected
  // repository counts as `yours` — "it is": the user owns it, Motir never bills
  // its CI, there is nothing to move. Every clause of that is still true about
  // the repository and the count was still wrong for this HEADER, which sits
  // above a list of the PROJECT's repositories. A number above a list must count
  // the things in that list.

  it('⚠️ NOW HOLDS THE INVERSE: an organisation repository this project has not added counts NOWHERE', () => {
    // §18.2's observed reading, as one assertion. The page reported
    // `0 moving · 0 hosted by Motir · 6 yours` on a project holding NO links —
    // six being the size of the organisation. It now reports three zeroes, which
    // is Panel 9's drawn state.
    expect(summarizeRepositories([])).toEqual({ moving: 0, hosted: 0, yours: 0 });
  });

  it('counts the three ownerships separately — they are legal at once', () => {
    const counts = summarizeRepositories([
      row({ name: 'hosted' }),
      row({ name: 'moving', takeover: 'transfer_pending' }),
      row({ name: 'taken', takeover: 'done' }),
      row({ name: 'brought', state: 'connected' }),
    ]);
    // One row moving must never make the whole project read as "moving".
    // `taken` and `brought` are both `yours` by §18.4: a completed takeover and
    // an organisation-owned link are the same answer to "who owns it now".
    expect(counts).toEqual({ moving: 1, hosted: 1, yours: 2 });
  });

  it('does not count a FAILED takeover as moving — a refused request is not in flight', () => {
    expect(summarizeRepositories([row({ name: 'x', takeover: 'failed' })])).toEqual({
      moving: 0,
      hosted: 1,
      yours: 0,
    });
  });

  it('⚠️ a completed takeover moves BUCKET without moving SECTION', () => {
    // §18.4's one genuinely surprising definition, and the reason the summary and
    // the split are asserted against ONE fixture here. The row counts as `yours`
    // — Motir no longer owns it or pays its CI — while it stays in the hosted
    // SECTION, where the takeover history and its finished state stay legible.
    // The section answers "where did this come from"; the count answers "who owns
    // it now". Reading either off the other is the bug this pins.
    const rows = [row({ name: 'taken', takeover: 'done' })];
    expect(summarizeRepositories(rows).yours).toBe(1);
    expect(splitRoomSections(rows).motirHosted.map((r) => r.id)).toEqual(['row-taken']);
    expect(splitRoomSections(rows).fromOrganization).toEqual([]);
  });
});

// ⚠️ A REPOSITORY MOTIR HOSTS IS NOT THE ORGANISATION'S (bug MOTIR-4867),
// RE-POINTED BY MOTIR-4954.
//
// `connected` is `githubRepoRepository.listByWorkspace`, filtered on
// `github_repo.workspace_id` and nothing else — the read that answers *can this
// workspace dispatch into it*, which MOTIR-1931 widened on purpose so a
// repository Motir CREATES for a workspace is a legal `targetRepo`. Read as
// *whose is it*, a Motir-hosted repository was drawn under `From your
// organisation` and counted in `yours` — whose own promise is *the user owns it,
// Motir never bills its CI, and there is nothing to move*, all three inverted.
//
// ⚠️ THE ROOM NO LONGER ASKS THIS QUESTION AT ALL, which is a stronger fix than
// the classification was: it draws links, and a link's ownership comes from its
// own row. So these cases move OFF `splitRoomSections` / `summarizeRepositories`
// and onto `organizationConnected` itself, which is the shared predicate and is
// still live — `lib/services/projectRepoRoomService.ts` composes the room view
// with its sibling `connectedNotInSet`, and `hostOwnershipAgreement.test.ts` pins
// it against the organisation inventory. Deleting these cases with the caller
// would leave that predicate unguarded on the way to MOTIR-4955, which is the
// card that retires it.
describe('a repository under the PROVISIONING organisation', () => {
  it('is not the organisation`s — the classification MOTIR-4867 added, at its own door', () => {
    expect(
      organizationConnected([hostedConnected('motir'), orgConnected('motir-core')], HOST_OWNER).map(
        (r) => r.repoRef,
      ),
    ).toEqual(['moooon-B-V/motir-core']);
  });

  it('matches the owner CASE-INSENSITIVELY — a GitHub login is, and the value is configuration', () => {
    // `provisioningOrgLogin()` returns whatever an operator typed into
    // `GITHUB_FALLBACK_ORG`; the same comparison the CI meter's §5.1 gate makes.
    expect(
      organizationConnected([hostedConnected('motir', 'MOTIR-Projects')], 'motir-projects'),
    ).toEqual([]);
  });

  it('⚠️ classifies NOTHING when `hostOwner` is null — a deployment that cannot provision hosts nothing', () => {
    // The counterfactual that keeps this rule from narrowing a self-hosted
    // deployment. With no `GITHUB_FALLBACK_ORG` there is no provisioning org, so
    // the answer is byte-for-byte what it was before the rule existed.
    expect(
      organizationConnected([hostedConnected('motir'), orgConnected('motir-core')], null).map(
        (r) => r.repoRef,
      ),
    ).toEqual(['motir-projects/motir', 'moooon-B-V/motir-core']);
  });

  it('reads the owner off `repoRef`, and degrades honestly on a ref with no owner', () => {
    // `ProjectRepoConnectedDto` carries no `owner` column — its own doc says why
    // — so the owner is the `repoRef` segment. A ref that somehow holds no `/` is
    // nobody's provisioning org, so it stays.
    const bare: ProjectRepoConnectedDto = {
      name: 'motir',
      repoRef: 'motir',
      defaultBranch: 'main',
    };
    expect(organizationConnected([bare], HOST_OWNER)).toEqual([bare]);
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
