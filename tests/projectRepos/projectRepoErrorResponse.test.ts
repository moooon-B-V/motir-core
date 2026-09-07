import { describe, expect, it } from 'vitest';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoStateTransitionError,
  RealizedRepoAlreadyClaimedError,
  RepoTransferRefusedError,
} from '@/lib/projectRepos/errors';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';

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

  it('answers a PERMISSION refusal with 403 and NAMES the key that was missing', async () => {
    // MOTIR-2299 — the SET writes and the code-access grant moved from
    // `assertCanEdit` to `assertPermission(…, 'repository:manage' /
    // 'repository:manage_access')`, so the refusal now arrives as
    // `PermissionDeniedError`. Unmapped it would be a 500, which is precisely how
    // the sibling mappers were caught (the story E2E's first CI run).
    for (const key of ['repository:manage', 'repository:manage_access'] as const) {
      const res = mapProjectRepoError(new PermissionDeniedError('proj-1', key));
      expect(res?.status).toBe(403);
      const body = (await res!.json()) as { code: string; permission: string };
      expect(body.code).toBe('PERMISSION_DENIED');
      // The KEY on the body is the whole point of the new error — a shared arm
      // with `ProjectAccessDeniedError` would return the right status and
      // silently drop it.
      expect(body.permission).toBe(key);
    }
  });

  it('still answers the OLD access denial with a 403 that carries no permission', async () => {
    // The two arms are separate on purpose, and this is the half that proves it:
    // `ProjectAccessDeniedError` keeps the body it shipped with, so a consumer
    // reading `code` is unaffected by the split.
    const res = mapProjectRepoError(new ProjectAccessDeniedError('proj-1', 'edit'));
    expect(res?.status).toBe(403);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.code).toBe('PROJECT_ACCESS_DENIED');
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
  });

  it('⚠️ the ORG-tier gate keeps the ORG tier\u2019s posture: 404 for a non-member, 403 for a member', async () => {
    // Story MOTIR-4669 · MOTIR-4678. The two arms are NOT flattened into the
    // project tier's single 403, and the asymmetry is the decision: an
    // organisation the caller is not in must be indistinguishable from one that
    // does not exist, while a plain member can already SEE the organisation, so
    // there is nothing left to hide from them — only the action to refuse.
    const notAMember = mapProjectRepoError(new OrganizationNotFoundError('org-1'));
    expect(notAMember?.status).toBe(404);
    expect((await notAMember!.json()).code).toBe('ORGANIZATION_NOT_FOUND');

    const memberButNotAdmin = mapProjectRepoError(new OrgForbiddenError('user-1', 'org-1'));
    expect(memberButNotAdmin?.status).toBe(403);
    expect((await memberButNotAdmin!.json()).code).toBe('ORG_FORBIDDEN');
  });

  it('answers an UPSTREAM refusal with 502 — not a 4xx blaming the caller', async () => {
    // MOTIR-711's takeover: GitHub refused, and no change to the request would
    // fix it. A 4xx here would tell the person to edit something and try again,
    // which is exactly the wrong instruction — the row is already `failed` with
    // the reason recorded and is re-promptable.
    const res = mapProjectRepoError(new RepoTransferRefusedError('repository is archived'));
    expect(res?.status).toBe(502);
    expect((await res!.json()).code).toBe('REPO_TRANSFER_REFUSED');
  });

  it('returns NULL for anything it does not know, so the route rethrows into a 500', () => {
    expect(mapProjectRepoError(new Error('the database went away'))).toBeNull();
    expect(mapProjectRepoError('not even an error')).toBeNull();
    expect(mapProjectRepoError(null)).toBeNull();
  });
});
