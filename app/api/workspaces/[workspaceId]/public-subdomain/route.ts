import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapPublicAddressError } from '@/lib/publicAddresses/errorResponse';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET / PUT / DELETE /api/workspaces/[workspaceId]/public-subdomain
// Story MOTIR-3878 · Subtask MOTIR-4215; DELETE is Story MOTIR-4451 ·
// Subtask MOTIR-4454 (ADR §8 Amendment 2).
//
// GET    — the workspace's subdomain DTO, or `null` when it has none.
// PUT    — `{ label }`. CLAIMS when the workspace has no subdomain and RENAMES
//          when it has one. One verb, because from the customer's side there is
//          one control — a field with the address in it — and which of the two
//          acts it performs is a fact about the server's state rather than a
//          choice the caller makes. The service still keeps them distinct
//          internally, so a rename spends a rename from the cap and a claim does
//          not.
// DELETE — RELEASE the subdomain: the live label and every retained alias stop
//          being addresses, and every one of those names is reserved for ever.
//          `204`, because there is no resource left to describe; `404` when the
//          workspace has none, which is a DIFFERENT typed error from the
//          rename's 409 rather than the same one mapped twice
//          (`SubdomainNotFoundError`).
//
// ⚠️ DELETE takes no body and therefore has no "which act is this?" branch —
// unlike PUT, whose one verb serves two acts. It is a separate verb rather than
// a `PUT { label: null }` because release is not a kind of naming: it is the one
// operation §8 had no way to express.
//
// Thin HTTP transport per `CLAUDE.md`: parse, gate, ONE service call, map typed
// errors. Every rule — the cloud gate, the membership gate, the label grammar,
// the rename cap, the row lock — lives in the service.

interface RouteParams {
  params: Promise<{ workspaceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { workspaceId } = await params;
  try {
    const dto = await publicSubdomainService.getForWorkspace(workspaceId, ctx.userId);
    return NextResponse.json(dto);
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const label =
    body && typeof body === 'object' && 'label' in body && typeof body.label === 'string'
      ? body.label
      : null;
  if (!label) {
    return NextResponse.json(
      { error: 'A "label" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    // Which act this is, is a question about SERVER STATE, so the server
    // answers it — not the caller through a second endpoint or a flag they
    // could get wrong.
    const existing = await publicSubdomainService.getForWorkspace(workspaceId, ctx.userId);
    const dto = existing
      ? await publicSubdomainService.rename(workspaceId, label, ctx.userId)
      : await publicSubdomainService.claim(workspaceId, label, ctx.userId);
    return NextResponse.json(dto, { status: existing ? 200 : 201 });
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { workspaceId } = await params;

  try {
    await publicSubdomainService.release(workspaceId, ctx.userId);
    // 204 — the resource is gone, and there is nothing to say about it. The
    // pane REFRESHES rather than patching local state, so it re-reads the DTO
    // from GET anyway; returning a body here would give it a second, staler
    // source for the same fact.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapPublicAddressError(err);
    if (mapped) return mapped;
    throw err;
  }
}
