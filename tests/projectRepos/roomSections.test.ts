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
    );
    expect(fromOrganization.map((e) => e.kind)).toEqual(['domain', 'domain']);
    expect(motirHosted).toEqual([]);
  });

  it('⚠️ reads the LADDER`s boolean, never a count — a project answered by its set alone', () => {
    // The counterfactual that keeps `layersConnected` honest. A project born in
    // Motir is answered by its set completely, so nothing is layered even if the
    // caller hands over a non-empty list.
    const { fromOrganization } = splitRoomSections([], [connected('motir-core')], false);
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
    );
    expect(motirHosted.map((r) => r.id)).toEqual(['row-hosted']);
    expect(fromOrganization.map((e) => e.id)).toEqual(['row-picked']);
  });

  it('the split over the SET is total — no row is lost and none is duplicated', () => {
    const rows = [row({ name: 'a' }), orgRow('b'), row({ name: 'c' })];
    const { fromOrganization, motirHosted } = splitRoomSections(rows, [], true);
    const links = fromOrganization.filter((e) => e.kind === 'link');
    expect(links.length + motirHosted.length).toBe(rows.length);
  });
});

describe('summarizeRepositories', () => {
  it('counts a connected repository as YOURS — it is', () => {
    // The header-level form of the defect: a summary read off the set alone
    // reports `0 yours` for a project holding four repositories of its own.
    expect(summarizeRepositories([], [connected('a'), connected('b')])).toEqual({
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
    );
    // One row moving must never make the whole project read as "moving".
    expect(counts).toEqual({ moving: 1, hosted: 1, yours: 3 });
  });

  it('does not count a FAILED takeover as moving — a refused request is not in flight', () => {
    expect(summarizeRepositories([row({ name: 'x', takeover: 'failed' })], [])).toEqual({
      moving: 0,
      hosted: 1,
      yours: 0,
    });
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
