import { NextResponse } from 'next/server';

import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { mapCustomDomainError } from '@/lib/publicAddresses/errorResponse';
import { customDomainService } from '@/lib/services/customDomainService';
import { getWorkspaceContext } from '@/lib/workspaces';

// POST / DELETE /api/projects/[key]/public-addresses/[addressId]/primary
// Story MOTIR-3878 · MOTIR-4216 — the ADR §7 *make primary*, and clearing it
// back to the default rule.

interface RouteParams {
  params: Promise<{ key: string; addressId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { addressId } = await params;
  try {
    return NextResponse.json(
      await customDomainService.makePrimary({ addressId, actorUserId: ctx.userId, ctx }),
    );
  } catch (err) {
    const mapped = mapCustomDomainError(err);
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

  const { key } = await params;
  try {
    await customDomainService.clearPrimary({ key, actorUserId: ctx.userId, ctx });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapCustomDomainError(err);
    if (mapped) return mapped;
    throw err;
  }
}
