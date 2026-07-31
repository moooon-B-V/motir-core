import { describe, expect, it } from 'vitest';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
} from '@/lib/projectRepos/errors';

// The repository-SET routes' typed-error → HTTP mapping (Story MOTIR-1775 ·
// MOTIR-1782). Five route files share it, so the whole point is that they cannot
// drift on what a name collision or a lost transition race means — which is only
// guaranteed if every class is pinned to a status HERE rather than in five catch
// blocks.
//
// The last case is the load-bearing one: an UNMAPPED error returns null so the
// route rethrows it as a 500. A helper that quietly turned an unknown failure into
// a 4xx would tell the client its request was wrong when the server broke.

describe('mapProjectRepoError', () => {
  it('hides a missing project and a missing row alike, as 404', async () => {
    for (const err of [new ProjectNotFoundError('PROD'), new ProjectRepoNotFoundError('row-1')]) {
      const res = mapProjectRepoError(err);
      expect(res?.status).toBe(404);
      expect(await res!.json()).toEqual({ code: err.code, error: err.message });
    }
  });

  it('answers a browse-but-not-edit member with 403', async () => {
    const err = new ProjectAccessDeniedError('proj-1', 'edit');
    const res = mapProjectRepoError(err);
    expect(res?.status).toBe(403);
    expect((await res!.json()).code).toBe(err.code);
  });

  it('answers every CONFLICT with the set’s current state as 409 — including the lost race', async () => {
    const conflicts = [
      new ProjectRepoNameTakenError('acme-web', 'proj-1'),
      new RealizedRepoAlreadyClaimedError('gh-1'),
      // A settled row has no legal hop; a caller that raced and lost lands here,
      // and 409 is what tells them to re-read and try again.
      new ProjectRepoStateTransitionError('row-1', 'created', 'skipped', []),
    ];
    for (const err of conflicts) {
      const res = mapProjectRepoError(err);
      expect(res?.status).toBe(409);
      expect((await res!.json()).code).toBe(err.code);
    }
  });

  it('answers a shape-rule rejection with 422', async () => {
    const err = new ProjectRepoInvalidFieldError('name', 'it must not be blank.');
    const res = mapProjectRepoError(err);
    expect(res?.status).toBe(422);
    expect((await res!.json()).code).toBe('PROJECT_REPO_INVALID_FIELD');
  });

  it('returns NULL for anything it does not know, so the route rethrows into a 500', () => {
    expect(mapProjectRepoError(new Error('the database went away'))).toBeNull();
    expect(mapProjectRepoError('not even an error')).toBeNull();
    expect(mapProjectRepoError(null)).toBeNull();
  });
});
