import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { RepoNotInProjectError } from '@/lib/git/errors';
import { repoChangesService } from '@/lib/services/repoChangesService';

// GET /api/internal/ai/repo-changes?repoRef=owner/name&head=feat/x[&base=main]
// (Story MOTIR-6617 · MOTIR-6619) — which PATHS a branch changed against a base,
// the listing a planning session reads a neighbour's in-flight branch through
// before reading those paths with `repo-file`. Same §4a service bearer + §4b job
// token as `repo-file`, and the same query shape.
//
// ⚠️ A REPOSITORY OUTSIDE THE JOB'S PROJECT SET IS A 404, and no provider is
// called for it. Every OTHER answer — no such ref, a revoked connection, a diff
// the host would not build, a host that did not answer — is 200 with a NAMED
// outcome, `repo-file`'s rule: the consumer is a model, and those are answers to
// reason from rather than failures to retry.
//
// ⚠️ NAMES ONLY, AND NOTHING CREDENTIAL-SHAPED. The response carries paths,
// statuses, the two refs and the two SHAs; the token is minted in-process and
// never serialized, and `tests/integration/ai/repoChangesRoute.test.ts` greps the
// serialized payload for it.

/**
 * The invocation budget for this route. It must stay ABOVE
 * `CHANGED_FILES_TIMEOUT_MS`, so a dead host surfaces as the `host_error`
 * outcome inside the budget; `tests/git/listChangedFiles.test.ts` asserts the
 * ordering.
 */
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const repoRef = params.get('repoRef');
  const head = params.get('head')?.trim();
  const base = params.get('base');
  if (!repoRef) {
    return NextResponse.json(
      { code: 'validation_error', error: 'repoRef is required' },
      { status: 400 },
    );
  }
  if (!head) {
    return NextResponse.json(
      { code: 'validation_error', error: 'head is required' },
      { status: 400 },
    );
  }

  try {
    const result = await repoChangesService.listChangedFiles(
      { userId: auth.ctx.userId, workspaceId: auth.ctx.workspaceId, projectId: auth.projectId },
      repoRef,
      head,
      base ?? undefined,
    );
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof RepoNotInProjectError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
