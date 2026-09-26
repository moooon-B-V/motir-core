import { NextResponse } from 'next/server';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  CrossWorkspaceLinkError,
  DuplicateLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkItemLinkNotFoundError,
} from '@/lib/workItems/linkErrors';
import type { LinkWorkItemsInput } from '@/lib/dto/workItemLinks';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { notFound, productionGate, requireContext } from '../_helpers';

// `_test` transport over the work-item-link surface of workItemsService
// (Subtask 1.4.8). See ../_helpers.ts for the WHY + the three invariants.
// Surface:
//
//   POST   body=LinkWorkItemsInput → 201 + WorkItemLinkDto
//   DELETE ?id=<linkId>            → 204 (unlink)
//   GET    ?workItemId=<id>&direction=blockers → WorkItemSummaryDto[] (getBlockers)
//   GET    ?workItemId=<id>&direction=blocking → WorkItemSummaryDto[] (getBlocking)
//   GET    ?workItemId=<id>&ready=1            → { ready: boolean } (isReady)
//
// Every read/mutation is gated to the active workspace via a getWorkItem /
// getLink tenancy guard (the application-layer isolation; RLS is inert on the
// BYPASSRLS dev connection — see _helpers.ts).

/**
 * Map a typed link / work-item error to an HTTP response, or rethrow. The
 * cycle response carries the `WI_LINK_CYCLE` marker the spec + verification
 * recipe grep for. Cross-workspace + not-found collapse to a uniform 404 (no
 * existence leak); self-link is 422; duplicate is 409.
 */
function mapError(err: unknown): NextResponse {
  if (err instanceof WorkItemLinkCycleError) {
    return NextResponse.json(
      { code: err.code, marker: 'WI_LINK_CYCLE', error: err.name, message: err.message },
      { status: 409 },
    );
  }
  if (err instanceof DuplicateLinkError) {
    return NextResponse.json({ code: err.code, error: err.name }, { status: 409 });
  }
  if (err instanceof SelfLinkError) {
    return NextResponse.json({ code: err.code, error: err.name }, { status: 422 });
  }
  if (
    err instanceof CrossWorkspaceLinkError ||
    err instanceof WorkItemLinkNotFoundError ||
    err instanceof WorkItemNotFoundError
  ) {
    return notFound();
  }
  throw err;
}

export async function GET(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const params = new URL(req.url).searchParams;
  const workItemId = params.get('workItemId');
  if (!workItemId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Provide ?workItemId=<id>' },
      { status: 400 },
    );
  }

  try {
    // Tenancy guard: the work item must be visible to the caller, else 404 —
    // so a foreign workspace's dependency graph (and its links) is unreachable.
    await workItemsService.getWorkItem(workItemId, ctx);

    if (params.get('ready') === '1') {
      return NextResponse.json({ ready: await workItemsService.isReady(workItemId, ctx) });
    }
    const direction = params.get('direction');
    if (direction === 'blockers') {
      return NextResponse.json(await workItemsService.getBlockers(workItemId, ctx));
    }
    if (direction === 'blocking') {
      return NextResponse.json(await workItemsService.getBlocking(workItemId, ctx));
    }
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Provide &direction=blockers|blocking or &ready=1' },
      { status: 400 },
    );
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const body = (await req.json()) as LinkWorkItemsInput;
  try {
    // Gate on the FROM item: a caller may only create links anchored in their
    // own workspace. (The service additionally rejects a cross-workspace pair;
    // this guard stops a caller linking two items that both live elsewhere.)
    await workItemsService.getWorkItem(body.fromId, ctx);
    const dto = await workItemsService.linkWorkItems(body, ctx);
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Provide ?id=<linkId>' },
      { status: 400 },
    );
  }
  try {
    await workItemsService.getLink(id, ctx); // tenancy guard (404 on cross-tenant)
    await workItemsService.unlinkWorkItems(id, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return mapError(err);
  }
}
