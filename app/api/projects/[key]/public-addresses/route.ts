import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// GET / POST /api/projects/[key]/public-addresses — Story MOTIR-3878 · MOTIR-4216.
// List a project's addresses; connect a customer domain.
// Thin HTTP transport per CLAUDE.md: parse → gate → ONE service call → mapping.

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key } = await params;
  try {
    return NextResponse.json(await customDomainService.list({ key, actorUserId: ctx.userId, ctx }));
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { key } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const hostname =
    body && typeof body === 'object' && 'hostname' in body && typeof body.hostname === 'string'
      ? body.hostname
      : null;
  if (!hostname) {
    return NextResponse.json(
      { error: 'A "hostname" is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const dto = await customDomainService.add({ key, hostname, actorUserId: ctx.userId, ctx });
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
