import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentAttachment } from '@/lib/api/v1/workItems/schema';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/attachments (Story MOTIR-3000 · Subtask
// MOTIR-3057) — the GENERAL attachment door, and the FOURTH upload entrance.
//
// ⚠️ NOT the first token-authenticated way to put a file on a work item. The
// acceptance-evidence and design-evidence publishers both accept a bearer PAT
// and both resolve the workspace from the token. What is new here is that the
// entrance is TYPE-AGNOSTIC: no artifact-kind enum, no per-lifecycle allowlist,
// no panel exclusion — so a `research` findings document, a `review`'s notes or
// a `verification`'s evidence can reach a card without inventing a lifecycle
// first. Which door a given deliverable uses is settled in
// `docs/decisions/attachment-api-door.md` §3; a DESIGN asset is not this one's.
//
// ── What this route does NOT do, deliberately ──────────────────────────────
// It re-implements no gate. Size, MIME, the per-user upload throttle and the
// organization's storage cap all live in `attachmentsService`, which the
// BROWSER route already calls, and every one of them raises a typed error the
// wrapper maps through `DOMAIN_ERROR_STATUS`. That is what makes the two
// entrances answer one rule with one status rather than drifting into two error
// vocabularies — asserted by driving both routes in one test file
// (`tests/api/v1/attachments-route.test.ts`).
//
// ── The size ceiling is the platform's, and it is NOT enforced here ────────
// `attachmentsService` enforces the org's per-file entitlement (10 MB free /
// 100 MB paid). A direct multipart POST to a serverless function is separately
// capped at ~4.5 MB, BELOW the entitlement on every tier, and that request is
// rejected before this handler runs — so there is nothing to catch and nothing
// to map. The ceiling is documented on the operation instead
// (`attachment-api-door.md` §1), where a client reads it.
//
// ── Addressing ─────────────────────────────────────────────────────────────
// `{key}`, like every other v1 work-item route — `MOTIR-3000`, not an internal
// id. The internal `[id]` form stays on the session-bound and evidence routes.

// The permission: attaching a file to a card is EDITING that card. The same one
// both publish routes assert, and — the property MOTIR-3058 depends on — one
// `CLI_TOKEN_GRANT` carries, so a dispatched agent can actually call it.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  let file: FormDataEntryValue | null;
  try {
    const form = await ctx.req.formData();
    file = form.get('file');
  } catch {
    throw new InvalidRequestError(
      'INVALID_MULTIPART_BODY',
      'Expected a `multipart/form-data` body carrying a `file` field.',
    );
  }
  // A missing field, a text value where a file was meant, and an EMPTY file
  // are all the same caller-fixable mistake. Zero bytes is worth refusing
  // rather than storing: it costs a blob write and produces an attachment
  // that can only ever disappoint whoever clicks it.
  if (!(file instanceof File) || file.size === 0) {
    throw new InvalidRequestError(
      'INVALID_MULTIPART_BODY',
      'Expected a non-empty `file` field in the multipart body.',
    );
  }

  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  // ONE service call. `attachToWorkItem` runs the view gate, the
  // `attachment:create` check, every upload gate, the blob write, and the
  // link + History revision — the same path the panel takes, differing only
  // in the source it stamps.
  const created = await attachmentsService.attachToWorkItem(item.id, file, ctx.service, 'api');

  return NextResponse.json(presentAttachment(created, identifier), { status: 201 });
});
