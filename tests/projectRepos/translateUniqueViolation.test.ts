import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { translateUniqueViolation } from '@/lib/services/projectRepoSetService';
import { translateLinkViolation } from '@/lib/services/organizationRepoService';
import {
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// `projectRepoSetService.translateUniqueViolation`, driven DIRECTLY — Bug MOTIR-5273.
//
// MOTIR-4833 repaired `organizationRepoService`'s translator and left this one,
// which read `meta.target` alone. Under this client `meta.target` is ABSENT, so
// its claim arm could never fire: the REALIZE path (which passes no name)
// re-threw the raw `PrismaClientKnownRequestError` — a 500 — and the APPEND /
// RENAME paths reported every race as "that name is taken". MOTIR-4833's own test
// asserted the positive and passed while this sibling was broken, so this file
// pins the NEGATIVE as well: a raw P2002 never leaves either translator.

/** The three call sites, each with the fallback it actually passes. */
const CALL_SITES = {
  append: { projectId: 'proj-1', name: 'motir-core', githubRepoId: null },
  rename: { projectId: 'proj-1', name: 'motir-core', githubRepoId: 'repo-a' },
  realize: { projectId: 'proj-1', name: 'motir-core', githubRepoId: 'repo-a' },
} as const;

function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

/** The shape MEASURED on a lost race under this client: no `target`, the name
 *  only in the driver's message. */
function measured(constraint: string): Prisma.PrismaClientKnownRequestError {
  return p2002({
    modelName: 'ProjectRepo',
    driverAdapterError: {
      cause: {
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
      },
    },
  });
}

const CLAIM = measured('project_repository_project_id_github_repo_id_key');
const NAME = measured('project_repository_project_id_name_key');
const UNNAMED = p2002({ modelName: 'ProjectRepo' });

function thrownBy(fn: () => never): unknown {
  try {
    fn();
  } catch (thrown) {
    return thrown;
  }
  throw new Error('the translator returned instead of throwing');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('translateUniqueViolation — the claim race is a CLAIM from every call site that holds a repository', () => {
  it.each(['realize', 'rename'] as const)(
    '%s: a lost `(projectId, githubRepoId)` race is RealizedRepoAlreadyClaimedError — not a 500, not a name error',
    (site) => {
      const thrown = thrownBy(() => translateUniqueViolation(CLAIM, CALL_SITES[site]));
      expect(thrown).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
      expect(thrown).not.toBeInstanceOf(ProjectRepoNameTakenError);
      expect(thrown).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    },
  );

  it('realize: classifies from the older `meta.target` shapes as well', () => {
    for (const target of [
      ['project_id', 'github_repo_id'],
      'project_repository_project_id_github_repo_id_key',
    ]) {
      expect(
        thrownBy(() => translateUniqueViolation(p2002({ target }), CALL_SITES.realize)),
      ).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
    }
  });

  it('append: a claim it cannot attribute to a repository is the REMAINDER, never a guess', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thrown = thrownBy(() => translateUniqueViolation(CLAIM, CALL_SITES.append));
    expect(thrown).toBeInstanceOf(ProjectRepoLinkConflictError);
    expect((thrown as ProjectRepoLinkConflictError).githubRepoId).toBeNull();
  });
});

describe('translateUniqueViolation — the name race is a NAME from every call site', () => {
  it.each(['append', 'rename', 'realize'] as const)('%s', (site) => {
    const thrown = thrownBy(() => translateUniqueViolation(NAME, CALL_SITES[site]));
    expect(thrown).toBeInstanceOf(ProjectRepoNameTakenError);
  });
});

describe('translateUniqueViolation — an UNCLASSIFIABLE P2002 has its own typed name', () => {
  it.each(['append', 'rename', 'realize'] as const)('%s', (site) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const thrown = thrownBy(() => translateUniqueViolation(UNNAMED, CALL_SITES[site]));
    expect(thrown).toBeInstanceOf(ProjectRepoLinkConflictError);
    expect((thrown as ProjectRepoLinkConflictError).code).toBe('PROJECT_REPO_LINK_CONFLICT');
    // The instrument: the next occurrence is READ, not deduced.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a constraint the set does not own is the remainder too — named, but neither arm', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      thrownBy(() => translateUniqueViolation(measured('some_future_key'), CALL_SITES.realize)),
    ).toBeInstanceOf(ProjectRepoLinkConflictError);
  });

  it('anything that is NOT a P2002 passes through untouched', () => {
    const boom = new Error('connection reset');
    expect(thrownBy(() => translateUniqueViolation(boom, CALL_SITES.realize))).toBe(boom);
  });
});

describe('the NEGATIVE, pinned for BOTH services: a raw P2002 never leaves either translator', () => {
  const shapes = { CLAIM, NAME, UNNAMED, targetOnly: p2002({ target: ['project_id', 'name'] }) };

  it.each(Object.entries(shapes))('%s', (_label, err) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const fallback of Object.values(CALL_SITES)) {
      expect(thrownBy(() => translateUniqueViolation(err, fallback))).not.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
    }
    expect(
      thrownBy(() =>
        translateLinkViolation(err, {
          projectId: 'proj-1',
          name: 'motir-core',
          githubRepoId: 'repo-a',
        }),
      ),
    ).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
