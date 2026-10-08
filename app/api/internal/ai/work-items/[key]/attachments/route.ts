import { NextResponse } from 'next/server';
import {
  authenticateServiceRequest,
  ServiceAuthError,
  SystemPrincipalNotProvisionedError,
} from '@/lib/ai/serviceAuth';
import { aiWorkItemsService } from '@/lib/services/aiWorkItemsService';
import { enforceInternalServiceRateLimit } from '@/lib/rateLimit/aiGuard';
import { AttachmentError } from '@/lib/blob/errors';
import { EntitlementExceededError } from '@/lib/billing/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';

// POST /api/internal/ai/work-items/{key}/attachments (MOTIR-7723) — the
// SERVICE-authenticated attachment door. motir-ai files planning bugs through
// the sibling `POST /api/internal/ai/work-items` and holds no PAT, so the
// general door (`/api/v1/work-items/{key}/attachments`) is out of its reach;
// this is how the planning record's JSON lands on the bug as a file instead of
// riding inline in its body.
//
// Auth: the same service bearer as `work-items` (MOTIR-1451), acting as the
// Motir SYSTEM principal — so it can reach exactly the projects that route can
// file into, and nothing a tenant's job token could not already see.
//
// Thin transport (the 4-layer rule): authenticate → rate-limit → parse the
// multipart `file` → ONE service call (`aiWorkItemsService.attachFile`) → map
// typed errors. No gate is re-implemented here: size, MIME, the upload throttle
// and the storage cap live in `attachmentsService`, and answer with the same
// statuses the browser and v1 doors give them.
//
// Typed errors → status:
//   ServiceAuthError                     → 401
//   SystemPrincipalNotProvisionedError   → 500
//   malformed key / missing or empty file → 400
//   ProjectNotFoundError / WorkItemNotFoundError → 404 (no existence leak)
//   ProjectAccessDeniedError             → 404 browse / 403 edit
//   PermissionDeniedError                → 403
//   AttachmentError                      → its own status (413 / 415 / 429 / 403)
//   EntitlementExceededError             → 402

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(
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

  // After the bearer check, so an unauthenticated caller cannot spend the real
  // credential's budget (the same order `work-items` uses).
  const limited = await enforceInternalServiceRateLimit(req);
  if (limited) return limited;

  const { key } = await params;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key.trim())) {
    return fail('ATTACHMENTS_INVALID', 'The work-item key must look like `MOTIR-123`.', 400);
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get('file');
  } catch {
    return fail(
      'ATTACHMENTS_INVALID',
      'Expected a `multipart/form-data` body carrying a `file` field.',
      400,
    );
  }
  if (!(file instanceof File) || file.size === 0) {
    return fail('ATTACHMENTS_INVALID', 'Expected a non-empty `file` field.', 400);
  }

  try {
    const dto = await aiWorkItemsService.attachFile({ identifier: key, file }, auth.ctx);
    return NextResponse.json(
      {
        id: dto.id,
        workItemKey: key.trim().toUpperCase(),
        filename: dto.filename,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        contentPath: dto.blobUrl,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) return fail(err.code, err.message, 404);
    if (err instanceof ProjectAccessDeniedError) {
      return fail(err.code, err.message, err.kind === 'browse' ? 404 : 403);
    }
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof AttachmentError) return fail(err.code, err.message, err.status);
    if (err instanceof EntitlementExceededError) return fail(err.code, err.message, 402);
    throw err;
  }
}
