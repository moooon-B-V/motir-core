import { NextResponse } from 'next/server';
import {
  authenticateServiceRequest,
  ServiceAuthError,
  SystemPrincipalNotProvisionedError,
} from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';

// PATCH /api/internal/ai/work-items/{key} (MOTIR-7723) — replace the description
// of a bug the Motir SYSTEM principal itself filed. The planning alarm files its
// bug with the machine record inline, attaches `planning-record.json` through
// the sibling `attachments` route, then settles the body here.
//
// Auth: the same service bearer as `POST /api/internal/ai/work-items`. The
// service bounds it to `bug`s whose reporter is the principal, so this can never
// edit a card a person wrote — anything else answers 404, like an unknown key.
//
// Thin transport (the 4-layer rule): authenticate → rate-limit → validate →
// ONE service call (`aiWorkItemsService.updateFiledBugDescription`) → map.
//
// Typed errors → status:
//   ServiceAuthError                     → 401
//   SystemPrincipalNotProvisionedError   → 500
//   malformed key / body                 → 400
//   ProjectNotFoundError / WorkItemNotFoundError → 404 (incl. not the principal's bug)
//   ProjectAccessDeniedError             → 404 browse / 403 edit
//   PermissionDeniedError                → 403

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await authenticateServiceRequest(req);
  } catch (err) {
    if (err instanceof ServiceAuthError) return fail(err.code, err.message, 401);
    if (err instanceof SystemPrincipalNotProvisionedError) return fail(err.code, err.message, 500);
    throw err;
  }

  const limited = await enforceInternalServiceRateLimit(req);
  if (limited) return limited;

  const { key } = await params;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key.trim())) {
    return fail('WORK_ITEMS_INVALID', 'The work-item key must look like `MOTIR-123`.', 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('WORK_ITEMS_INVALID', 'request body must be valid JSON', 400);
  }
  const { descriptionMd } = (body ?? {}) as Record<string, unknown>;
  if (typeof descriptionMd !== 'string') {
    return fail('WORK_ITEMS_INVALID', '`descriptionMd` is required and must be a string.', 400);
  }

  try {
    const dto = await aiWorkItemsService.updateFiledBugDescription(
      { identifier: key, descriptionMd },
      auth.ctx,
    );
    return NextResponse.json({ key: dto.identifier }, { status: 200 });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) return fail(err.code, err.message, 404);
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    throw err;
  }
}
