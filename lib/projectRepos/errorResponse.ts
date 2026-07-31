import { NextResponse } from 'next/server';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  GithubIdentityRequiredError,
  ProjectRepoInvalidFieldError,
  ProjectRepoNameTakenError,
  ProjectRepoNotFoundError,
  ProjectRepoNotTransferableError,
  ProjectRepoStateTransitionError,
  ProjectRepoTakeoverStateError,
  RealizedRepoAlreadyClaimedError,
  RepoTransferRefusedError,
} from '@/lib/projectRepos/errors';

/**
 * Shared typed-error → HTTP mapping for the repository-SET routes (Story
 * MOTIR-1775 · MOTIR-1782), the `mapLabelError` pattern. Returns null for errors
 * the route should rethrow — an unmapped error is a 500, and deliberately so.
 *
 * The mapping is the one each error class already documents on itself, kept in
 * ONE place so five route files cannot drift on what a name collision means:
 *
 *   ProjectNotFoundError / ProjectRepoNotFoundError → 404 (a missing row and
 *     another tenant's row are indistinguishable by construction — the
 *     no-existence-leak posture the set service inherits from the access gate)
 *   ProjectAccessDeniedError                        → 403 (a member who may
 *     browse the project but not edit it)
 *   ProjectRepoNameTakenError /
 *   RealizedRepoAlreadyClaimedError /
 *   ProjectRepoStateTransitionError                 → 409 (a conflict with the
 *     set's current state — including the LOST RACE, which is why the transition
 *     error is here and not at 422: the caller's move was legal when they chose
 *     it and a concurrent editor moved first, so re-reading and retrying is the
 *     correct response)
 *   ProjectRepoInvalidFieldError                    → 422 (a value the shape
 *     rules reject — a blank or over-long name, an illegal character)
 */
export function mapProjectRepoError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError || err instanceof ProjectRepoNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (
    err instanceof ProjectRepoNameTakenError ||
    err instanceof RealizedRepoAlreadyClaimedError ||
    err instanceof ProjectRepoStateTransitionError ||
    err instanceof ProjectRepoNotTransferableError ||
    err instanceof ProjectRepoTakeoverStateError ||
    err instanceof GithubIdentityRequiredError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof ProjectRepoInvalidFieldError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  // The takeover's upstream failure (MOTIR-711): GitHub refused, and no change to
  // the request would fix it — so it is a 502, not a 4xx blaming the caller. The
  // row is already `failed` with the reason recorded and is re-promptable.
  if (err instanceof RepoTransferRefusedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  return null;
}
