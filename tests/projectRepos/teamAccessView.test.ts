import { describe, expect, it } from 'vitest';
import {
  buildTeamAccessView,
  teamAccessSummary,
  type TeamAccessPerson,
} from '@/lib/projectRepos/teamAccessView';
import type {
  ProjectRepoDto,
  ProjectRepoMemberAccessDto,
  ProjectRepoTeamAccessDto,
} from '@/lib/dto/projectRepos';

// THE TEAM CODE-ACCESS VIEW MODEL (Story MOTIR-1775 · MOTIR-1945).
//
// The surface is MEMBER-primary over a REPOSITORY-primary read, so the whole
// question "what does one person's row say?" is decided here rather than in JSX —
// and every claim the design makes about the roll-up is a claim this file can
// falsify:
//   * `accepted` means EVERY invitable repository, never "most of them";
//   * a refusal is knowable only from the response of an attempt (nothing is
//     persisted), and it never fails the repository or the sibling members;
//   * a `connected` / `skipped` / unmade row is in the strip but out of the maths,
//     which is why a partial set needs no special case;
//   * the header count counts what is TRUE, not what was attempted.

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

/** Cross the members with the repositories the way MOTIR-1910's read does —
 *  one row per repository, each carrying the FULL candidate roster. */
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

const WEB = repo({ id: 'row-web', name: 'atlas-web' });
const API = repo({ id: 'row-api', name: 'atlas-api', role: 'api' });

function person(view: { people: TeamAccessPerson[] }, userId: string): TeamAccessPerson {
  const found = view.people.find((p) => p.userId === userId);
  if (!found) throw new Error(`no person ${userId}`);
  return found;
}

describe('buildTeamAccessView — the roll-up across the set', () => {
  it('accepted on EVERY invitable repository reads as access; two of three does not', () => {
    const dana = { userId: 'dana', name: 'Dana Ostrowski' };
    const view = buildTeamAccessView(
      access([
        {
          repo: WEB,
          members: [member({ ...dana, state: 'accepted', permission: 'push' })],
        },
        {
          repo: API,
          members: [member({ ...dana, state: 'accepted', permission: 'push' })],
        },
      ]),
      [WEB, API],
    );
    expect(person(view, 'dana').state).toBe('accepted');
    expect(view.grantedCount).toBe(1);

    const partial = buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ ...dana, state: 'accepted', permission: 'push' })] },
        { repo: API, members: [member({ ...dana, state: 'invited', permission: 'push' })] },
      ]),
      [WEB, API],
    );
    // Half the set is not access to the project's code — and the count must not
    // round it up to one.
    expect(person(partial, 'dana').state).toBe('invited');
    expect(partial.grantedCount).toBe(0);
    expect(person(partial, 'dana').sentCount).toBe(2);
    expect(person(partial, 'dana').acceptedCount).toBe(1);
  });

  it('opens the expansion by default ONLY when the repositories disagree', () => {
    const agree = buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ userId: 'm', name: 'M', state: 'invited' })] },
        { repo: API, members: [member({ userId: 'm', name: 'M', state: 'invited' })] },
      ]),
      [WEB, API],
    );
    expect(person(agree, 'm').disagree).toBe(false);

    const disagree = buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ userId: 'm', name: 'M', state: 'accepted' })] },
        { repo: API, members: [member({ userId: 'm', name: 'M', state: 'invited' })] },
      ]),
      [WEB, API],
    );
    expect(person(disagree, 'm').disagree).toBe(true);
  });

  it('a single-repository project never opens a row — one repository cannot disagree with itself', () => {
    const view = buildTeamAccessView(
      access([{ repo: WEB, members: [member({ userId: 'm', name: 'M', state: 'invited' })] }]),
      [WEB],
    );
    expect(person(view, 'm').cells).toHaveLength(1);
    expect(person(view, 'm').disagree).toBe(false);
  });

  it('rolls the permission up to admin — the larger grant wins over push', () => {
    const view = buildTeamAccessView(
      access([
        {
          repo: WEB,
          members: [
            member({ userId: 'o', name: 'Olivia', state: 'accepted', permission: 'admin' }),
          ],
        },
        {
          repo: API,
          members: [
            member({ userId: 'o', name: 'Olivia', state: 'accepted', permission: 'admin' }),
          ],
        },
      ]),
      [WEB, API],
    );
    expect(person(view, 'o').permission).toBe('admin');
  });
});

describe('buildTeamAccessView — a refusal', () => {
  const jonas = { userId: 'jonas', name: 'Jonas Vik' };

  function refused() {
    return buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ ...jonas, state: 'invited', permission: 'push' })] },
        { repo: API, members: [member({ ...jonas, state: 'not_invited' })] },
        {
          repo: repo({ id: 'row-sh', name: 'atlas-shared' }),
          members: [member({ ...jonas, state: 'invited', permission: 'push' })],
        },
      ]),
      [WEB, API, repo({ id: 'row-sh', name: 'atlas-shared' })],
      { failedUserIds: new Set(['jonas']) },
    );
  }

  it('names the repository GitHub turned down and marks only that cell', () => {
    const p = person(refused(), 'jonas');
    expect(p.state).toBe('failed');
    expect(p.failedRepoRef).toBe('motir-projects/atlas-api');
    expect(p.cells.filter((c) => c.failed)).toHaveLength(1);
    // The other two invitations still stand — a refusal on one repository is not
    // a refusal on its siblings.
    expect(p.sentCount).toBe(2);
  });

  it('never fails a member the pass could not even try', () => {
    const view = buildTeamAccessView(
      access([
        {
          repo: WEB,
          members: [
            member({ userId: 'nog', name: 'No GitHub', login: null, reason: 'no_github_identity' }),
            member({ userId: 'view', name: 'Viewer', eligible: false, reason: 'role_cannot_edit' }),
          ],
        },
      ]),
      [WEB],
      { failedUserIds: new Set(['nog', 'view']) },
    );
    // Neither was ever sent, so neither can have been refused: blaming GitHub for
    // a state Motir chose would put a red mark on a row nobody did anything wrong on.
    expect(person(view, 'nog').state).toBe('not_invited');
    expect(view.ineligible[0]?.state).toBe('ineligible');
  });
});

describe('buildTeamAccessView — eligibility, the set strip and the counts', () => {
  it('splits the ineligible members into their own list and out of the count', () => {
    const view = buildTeamAccessView(
      access([
        {
          repo: WEB,
          members: [
            member({ userId: 'a', name: 'A', state: 'accepted', permission: 'push' }),
            member({ userId: 'b', name: 'B' }),
            member({ userId: 't', name: 'Tom', eligible: false, reason: 'role_cannot_edit' }),
          ],
        },
      ]),
      [WEB],
    );
    expect(view.people.map((p) => p.userId)).toEqual(['a', 'b']);
    expect(view.ineligible.map((p) => p.userId)).toEqual(['t']);
    expect(view.eligibleCount).toBe(2);
    expect(view.grantedCount).toBe(1);
  });

  it('keeps a skipped and a connected row in the STRIP but out of the invitation maths', () => {
    const skipped = repo({
      id: 'row-skip',
      name: 'atlas-api',
      state: 'skipped',
      established: false,
    });
    const connected = repo({ id: 'row-own', name: 'atlas-shared', state: 'connected' });
    const view = buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ userId: 'm', name: 'M', state: 'accepted' })] },
        { repo: skipped, members: [member({ userId: 'm', name: 'M' })], invitable: false },
        { repo: connected, members: [member({ userId: 'm', name: 'M' })], invitable: false },
      ]),
      [WEB, skipped, connected],
    );

    expect(view.repos.map((r) => r.label)).toEqual([
      'motir-projects/atlas-web',
      'atlas-api',
      'motir-projects/atlas-shared',
    ]);
    expect(view.repos.map((r) => r.invitable)).toEqual([true, false, false]);
    expect(view.repos[1]?.established).toBe(false);
    expect(view.repos[2]?.connected).toBe(true);
    // One invitable repository, accepted → the member CAN clone the project's
    // code. A partial set needs no special case.
    expect(view.invitableCount).toBe(1);
    expect(person(view, 'm').cells).toHaveLength(1);
    expect(person(view, 'm').state).toBe('accepted');
    expect(view.grantedCount).toBe(1);
  });

  it('reports nothing_to_grant when the set holds no repository Motir made', () => {
    const connected = repo({ id: 'row-own', name: 'atlas-shared', state: 'connected' });
    const view = buildTeamAccessView(
      access([
        { repo: connected, members: [member({ userId: 'm', name: 'M' })], invitable: false },
      ]),
      [connected],
    );
    expect(view.invitableCount).toBe(0);
    expect(person(view, 'm').state).toBe('nothing_to_grant');
    expect(view.grantedCount).toBe(0);
  });

  it('names the repository still being made', () => {
    const creating = repo({
      id: 'row-new',
      name: 'atlas-api',
      state: 'creating',
      established: false,
    });
    const view = buildTeamAccessView(
      access([
        { repo: WEB, members: [member({ userId: 'm', name: 'M', state: 'invited' })] },
        { repo: creating, members: [member({ userId: 'm', name: 'M' })], invitable: false },
      ]),
      [WEB, creating],
    );
    expect(view.establishingRepoName).toBe('atlas-api');
  });

  it('renders an empty project without inventing a row', () => {
    const view = buildTeamAccessView({ projectId: 'proj-1', rows: [] }, []);
    expect(view.repos).toEqual([]);
    expect(view.people).toEqual([]);
    expect(view.ineligible).toEqual([]);
    expect(view.invitableCount).toBe(0);
    expect(view.grantedCount).toBe(0);
    expect(view.establishingRepoName).toBeNull();
  });

  it('contributes no cell for a row that does not carry the member', () => {
    // A set that changed between the two halves of a read: omitting the cell says
    // "not known", where filling it in from a sibling row would say something
    // false about a repository nobody asked about.
    const view = buildTeamAccessView(
      {
        projectId: 'proj-1',
        rows: [
          {
            rowId: WEB.id,
            repoRef: 'motir-projects/atlas-web',
            invitable: true,
            members: [member({ userId: 'm', name: 'M', state: 'accepted' })],
          },
          { rowId: API.id, repoRef: 'motir-projects/atlas-api', invitable: true, members: [] },
        ],
      },
      [WEB, API],
    );
    expect(person(view, 'm').cells).toHaveLength(1);
    expect(person(view, 'm').state).toBe('accepted');
  });

  it('carries the pending invitation URL, and only while it is pending', () => {
    const view = buildTeamAccessView(
      access([
        {
          repo: WEB,
          members: [
            member({
              userId: 'p',
              name: 'Priya',
              state: 'invited',
              invitationUrl: 'https://github.com/motir-projects/atlas-web/invitations',
            }),
          ],
        },
        { repo: API, members: [member({ userId: 'p', name: 'Priya', state: 'accepted' })] },
      ]),
      [WEB, API],
    );
    const cells = person(view, 'p').cells;
    expect(cells[0]?.invitationUrl).toContain('/invitations');
    expect(cells[1]?.invitationUrl).toBeNull();
  });
});

describe('teamAccessSummary — door 2 counts what is TRUE', () => {
  it('counts only the members who can actually clone', () => {
    const rows = access([
      {
        repo: WEB,
        members: [
          member({ userId: 'a', name: 'A', state: 'accepted' }),
          member({ userId: 'b', name: 'B', state: 'invited' }),
          member({ userId: 'c', name: 'C', login: null, reason: 'no_github_identity' }),
          member({ userId: 'd', name: 'D', eligible: false, reason: 'role_cannot_edit' }),
        ],
      },
    ]);
    // A pending invitation is not access, and a member with no account is not a
    // failure — 1 of 3, and the viewer is not one of the three.
    expect(teamAccessSummary(rows, [WEB])).toEqual({ granted: 1, eligible: 3 });
  });
});
