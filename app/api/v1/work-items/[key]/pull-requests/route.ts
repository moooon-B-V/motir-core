import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import {
  linkPullRequestBodySchema,
  parseV1Body,
  presentLinkedPullRequest,
} from '@/lib/api/v1/workItems/schema';
import { resolveCoordinate } from '@/lib/github/pullRequestCoordinate';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/work-items/{key}/pull-requests (Task MOTIR-5048) — DECLARE which
// pull request delivers this work item.
//
// ── Why this operation exists, when an MCP tool already did ─────────────────
// `link_pull_request` has been the door since MOTIR-3526, and it is an MCP tool,
// so only a dispatched AGENT could ever call it. `packages/cli` retired its MCP
// transport in 11.5.6 — every client method goes through `this.v1.request` —
// which left the ORCHESTRATOR unable to say what its own session pull request
// delivers. It is the one actor that always knows: it opened the pull request,
// and on a scoped run it has known which container that pull request delivers
// since before its first agent started. The tool and this route call the SAME
// service method, so there is one implementation and one lock.
//
// ── The route decides NOTHING ───────────────────────────────────────────────
// The permission assertion, the repository lookup, the row lock, the upsert and
// the delivery write all live in `githubPullRequestService
// .linkPullRequestByCoordinates`, which owns the single transaction. This file
// resolves a key, parses an address, and shapes a response.
//
// ── The address parser is IMPORTED, not re-derived ──────────────────────────
// `resolveCoordinate` lives in `lib/github/pullRequestCoordinate.ts` precisely so
// this route can have it: a v1 route may not import from `@/lib/mcp/`, and
// copying the parse would let the two doors drift about what `url` means. A key
// parse that drifts yields a 404 the caller sees; a coordinate parse that drifts
// links the WRONG pull request under a 200.
export const POST = withV1Route<{ key: string }>({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, linkPullRequestBodySchema);

  // Parsed BEFORE the item is read: an unparseable address is a request the
  // caller can fix, and answering it costs no database round trip. A 422 rather
  // than a 404 for the same reason `resolveWorkItemKey` refuses a malformed key
  // early — the fault is in the argument, not in what exists.
  const coordinate = resolveCoordinate(body);
  if (!coordinate.ok) throw new InvalidRequestError('INVALID_BODY', coordinate.message);

  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx.service);

  const result = await githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: item.id,
      projectId,
      owner: coordinate.owner,
      name: coordinate.name,
      number: coordinate.number,
      headRef: body.headRef,
      baseRef: body.baseRef,
      title: body.title ?? null,
    },
    ctx.service,
  );

  // 200, not 201. A link is a SET and this ADDS to it, so the same request twice
  // is not two creations — and `created` reports the one thing a caller cannot
  // derive: whether the pull-request ROW had to be written because no webhook
  // delivery had arrived yet.
  return NextResponse.json(presentLinkedPullRequest(identifier, result));
});
