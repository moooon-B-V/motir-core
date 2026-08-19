import { describe, expect, it } from 'vitest';
import { connectedNotInSet, summarizeRepositories } from '@/lib/projectRepos/roomSections';
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
