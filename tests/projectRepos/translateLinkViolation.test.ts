import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { translateLinkViolation } from '@/lib/services/organizationRepoService';
import {
  ProjectRepoLinkConflictError,
  ProjectRepoNameTakenError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// `translateLinkViolation`, driven DIRECTLY — Bug MOTIR-4833.
//
// The service's own concurrency suite reaches this function only by winning a
// race: two callers fire at one row, and whether the loser is stopped by a
// pre-check READ or by the INSERT is decided by the scheduler. So which arm of
// the translation runs is not something that suite chooses, and the arm that
// carried the defect was covered by accident for as long as it existed — a
// `meta.target` the function could not classify was ASSERTED to be a name
// collision by an unguarded `else`, which tells a person to rename something when
// the truth is that another write claimed the repository first.
//
// This file removes the luck. It hands the function each shape Prisma can
// actually produce and asserts the type for each, so the classification is pinned
// independently of who wins a race.
//
// ⚠️ AN ABSENT `meta.target` IS THE ORDINARY CASE ON THIS PATH, not an exotic
// one, which is why it is covered here rather than reasoned away. Measured
// against this schema's own database: `project_repository` is FORCE ROW LEVEL
// SECURITY and the app connects as a non-superuser role, so PostgreSQL declines
// to describe the conflicting key and the `23505` carries NO `DETAIL` line; and
// `@prisma/adapter-pg` derives `meta.target` from `error.detail` alone, never from
// the `constraint` name the database did report. No `DETAIL` ⇒ no `target`.
//
// The constraint name is not lost with it — it survives one level down, quoted,
// in `meta.driverAdapterError.cause.originalMessage`, which is the layer that
// actually classifies a production race (its own describe block below). What
// reaches the REMAINDER is the case where neither layer names a constraint.

const FALLBACK = {
  name: 'motir-core',
  githubRepoId: 'repo-a',
  projectId: 'proj-1',
} as const;

/** A `P2002` carrying exactly the `meta` under test — nothing else is stubbed. */
function uniqueViolation(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

function thrownBy(err: unknown): unknown {
  try {
    translateLinkViolation(err, FALLBACK);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('translateLinkViolation returned instead of throwing');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('translateLinkViolation — the classification is POSITIVE in both directions', () => {
  it('names the CLAIM when `meta.target` is the column list', () => {
    const thrown = thrownBy(uniqueViolation({ target: ['project_id', 'github_repo_id'] }));
    expect(thrown).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });

  it('names the CLAIM when `meta.target` is the index NAME', () => {
    const thrown = thrownBy(
      uniqueViolation({ target: 'project_repository_project_id_github_repo_id_key' }),
    );
    expect(thrown).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });

  it('names the NAME collision when `meta.target` is the column list', () => {
    const thrown = thrownBy(uniqueViolation({ target: ['project_id', 'name'] }));
    expect(thrown).toBeInstanceOf(ProjectRepoNameTakenError);
    expect(thrown).not.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
  });

  it('names the NAME collision when `meta.target` is the index NAME', () => {
    const thrown = thrownBy(uniqueViolation({ target: 'project_repository_project_id_name_key' }));
    expect(thrown).toBeInstanceOf(ProjectRepoNameTakenError);
  });

  // The layer that carries the answer in production. `meta.target` is absent for
  // every lost race on this path (see the header), and the constraint name
  // survives one level down, quoted, in the driver's own message — measured on a
  // real lost race under the `motir_app` role.
  describe('the DRIVER error names the constraint when `meta.target` does not', () => {
    function driverViolation(constraint: string) {
      return uniqueViolation({
        modelName: 'ProjectRepo',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
          },
        },
      });
    }

    it('names the CLAIM from the driver message', () => {
      const thrown = thrownBy(driverViolation('project_repository_project_id_github_repo_id_key'));
      expect(thrown).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
    });

    it('names the NAME collision from the driver message', () => {
      const thrown = thrownBy(driverViolation('project_repository_project_id_name_key'));
      expect(thrown).toBeInstanceOf(ProjectRepoNameTakenError);
      expect(thrown).not.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
    });

    it('falls to the remainder when the driver names a constraint we do not know', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const thrown = thrownBy(driverViolation('some_other_table_pkey'));
      expect(thrown).toBeInstanceOf(ProjectRepoLinkConflictError);
    });

    it('prefers the STRUCTURED target when both are present', () => {
      // Ordering matters if a future Prisma populates both and they ever disagree:
      // `meta.target` is parsed by the adapter, the message is prose.
      const err = driverViolation('project_repository_project_id_name_key');
      (err.meta as Record<string, unknown>)['target'] = ['project_id', 'github_repo_id'];
      expect(thrownBy(err)).toBeInstanceOf(RealizedRepoAlreadyClaimedError);
    });
  });

  // The regression this card exists for. Before the fix every one of these
  // produced `ProjectRepoNameTakenError` — a 409 reading "that name is taken" for
  // a condition renaming cannot fix.
  describe('an UNCLASSIFIABLE P2002 gets its own name, never a borrowed one', () => {
    const unclassifiable: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['`meta.target` absent (the RLS path — no DETAIL, so no target)', {}],
      ['`meta.target` explicitly undefined', { target: undefined }],
      ['`meta.target` null', { target: null }],
      ['`meta.target` an empty array', { target: [] }],
      ['`meta.target` naming neither constraint', { target: ['workspace_id'] }],
    ];

    for (const [label, meta] of unclassifiable) {
      it(`is a link conflict, not a name collision — ${label}`, () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const thrown = thrownBy(uniqueViolation(meta));
        expect(thrown).toBeInstanceOf(ProjectRepoLinkConflictError);
        expect(thrown).not.toBeInstanceOf(ProjectRepoNameTakenError);
        expect(thrown).not.toBeInstanceOf(RealizedRepoAlreadyClaimedError);
        expect((thrown as ProjectRepoLinkConflictError).code).toBe('PROJECT_REPO_LINK_CONFLICT');
      });
    }

    // The instrument. This defect cost an elimination argument to diagnose
    // precisely because nothing recorded what the unclassified branch had been
    // handed; the next occurrence should cost one log line.
    it('LOGS `err.code` and `err.meta` so the next occurrence is read, not deduced', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const meta = { modelName: 'ProjectRepo' };
      thrownBy(uniqueViolation(meta));
      expect(warn).toHaveBeenCalledTimes(1);
      const [, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(context).toMatchObject({
        code: 'P2002',
        meta,
        projectId: FALLBACK.projectId,
        githubRepoId: FALLBACK.githubRepoId,
      });
    });

    it('does NOT log on a classifiable violation — the warning means something', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      thrownBy(uniqueViolation({ target: ['project_id', 'github_repo_id'] }));
      thrownBy(uniqueViolation({ target: ['project_id', 'name'] }));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // The outer contract, unchanged: this function translates a P2002 and is
  // transparent to everything else. A translation that swallowed an unrelated
  // failure would be a worse version of the defect it just fixed.
  it('rethrows anything that is not a P2002, untouched', () => {
    const foreignKey = new Prisma.PrismaClientKnownRequestError('FK violated', {
      code: 'P2003',
      clientVersion: 'test',
      meta: { target: ['github_repo_id'] },
    });
    expect(thrownBy(foreignKey)).toBe(foreignKey);

    const plain = new Error('something else entirely');
    expect(thrownBy(plain)).toBe(plain);
  });
});
