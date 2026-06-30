import { NextResponse } from 'next/server';
import {
  authenticateServiceRequest,
  ServiceAuthError,
  SystemPrincipalNotProvisionedError,
} from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { ProjectNotFoundError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  WorkItemNotFoundError,
  IllegalParentTypeError,
  CrossProjectParentError,
  DepthLimitExceededError,
  ParentCycleError,
} from '@/lib/workItems/errors';

// POST /api/internal/ai/work-items (Subtask 7.6.13 · MOTIR-1450) — the internal,
// SERVICE-authenticated write path the AI self-learning loop uses to file ONE
// `kind: bug` into a NAMED project (965 inward / 967 outward, via the 1438
// engine tool). The immediate-create counterpart to the read/proposal routes:
// the AI requests, core persists with every guard applied.
//
// Auth: the MOTIR-1451 SERVICE bearer ONLY (`Authorization: Bearer
// <CORE_CALLBACK_SECRET>`) — NOT the §4b job token (single-tenant, 15-min) and
// NOT a cookie session. It acts as the Motir SYSTEM principal, so it can target
// a project OUTSIDE any one tenant's job (a sanitized customer-triggered
// meta-bug lands in MOTIR/PROD, never the customer's tenant).
//
// Thin transport (the 4-layer rule): authenticate → validate the body → ONE
// service call (`aiWorkItemsService.fileBug`) → map typed errors to status. All
// create validation (kind-parent matrix, 6.4 edit gate, 404-not-403 tenant
// gate) lives in `workItemsService.createWorkItem`, reached unbypassed.
//
// Typed errors → status:
//   ServiceAuthError                     → 401 (bad/missing/unset bearer)
//   SystemPrincipalNotProvisionedError   → 500 (the seed didn't run — invariant)
//   ProjectNotFoundError / WorkItemNotFoundError → 404 (unknown projectKey /
//                                          parentKey — cross-tenant 404-not-403)
//   ProjectAccessDeniedError             → 404 browse / 403 edit
//   IllegalParentTypeError / CrossProjectParentError /
//     DepthLimitExceededError / ParentCycleError → 422 (a parent the matrix forbids)

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  // ── Authenticate: the service bearer only (no job token, no cookie) ──
  let auth;
  try {
    auth = await authenticateServiceRequest(req);
  } catch (err) {
    if (err instanceof ServiceAuthError) return fail(err.code, err.message, 401);
    if (err instanceof SystemPrincipalNotProvisionedError) return fail(err.code, err.message, 500);
    throw err;
  }

  // ── Parse + validate the body ──
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('WORK_ITEMS_INVALID', 'request body must be valid JSON', 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const { projectKey, kind, title, descriptionMd, parentKey } = b;

  if (typeof projectKey !== 'string' || projectKey.trim() === '') {
    return fail('WORK_ITEMS_INVALID', '`projectKey` is required.', 400);
  }
  if (typeof title !== 'string' || title.trim() === '') {
    return fail('WORK_ITEMS_INVALID', '`title` is required.', 400);
  }
  // This route files ONLY bugs (the self-learning loop's sole need); any other
  // kind is a typed rejection, never a silent coercion.
  if (kind !== 'bug') {
    return fail('WORK_ITEMS_UNSUPPORTED_KIND', 'this route files only `kind: "bug"`.', 422);
  }
  if (descriptionMd != null && typeof descriptionMd !== 'string') {
    return fail('WORK_ITEMS_INVALID', '`descriptionMd` must be a string.', 400);
  }
  if (parentKey != null && typeof parentKey !== 'string') {
    return fail('WORK_ITEMS_INVALID', '`parentKey` must be a string.', 400);
  }

  // ── ONE service call ──
  try {
    const dto = await aiWorkItemsService.fileBug(
      {
        projectKey,
        title,
        descriptionMd: descriptionMd ?? null,
        parentKey: parentKey ?? null,
      },
      auth.ctx,
    );
    return NextResponse.json({ key: dto.identifier, id: dto.id }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof WorkItemNotFoundError) {
      return fail(err.code, err.message, 404);
    }
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    if (
      err instanceof IllegalParentTypeError ||
      err instanceof CrossProjectParentError ||
      err instanceof DepthLimitExceededError ||
      err instanceof ParentCycleError
    ) {
      return fail(err.code, err.message, 422);
    }
    throw err;
  }
}
