import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { consumeRateLimit } from '@/lib/rateLimit/fixedWindow';
import { organizationDeletionService } from '@/lib/services/organizationDeletionService';

// /api/organizations/[orgId]/deletion (Story MOTIR-6306 · MOTIR-6399) — schedule,
// cancel and read an organization's deletion. Thin HTTP layer over
// `organizationDeletionService` (CLAUDE.md § 4-layer): session-gated (401), the
// body parsed here, one service call, typed errors mapped by `mapOrgError`.
//
//   GET    → 200 { request, scheduledByName } (any member; 404 a non-member)
//   POST   { confirmName, password? } → 200 the scheduled request;
//          403 an Admin / Member, or STEP_UP_FAILED with `reason`
//          (`wrong_password` | `reauth_required`); 404 a non-member;
//          409 ORGANIZATION_DELETION_ALREADY_SCHEDULED; 422 the wrong name;
//          429 too many attempts (it verifies a password).
//   DELETE → 200 { outcome: 'cancelled' | 'none' }; 409 ALREADY_STARTED.

/** Attempts per Owner per window — a password is verified on every POST. */
const SCHEDULE_ATTEMPTS = 5;
const SCHEDULE_WINDOW_MS = 15 * 60 * 1000;

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  try {
    return NextResponse.json(
      await organizationDeletionService.getOrganizationDeletion(orgId, gate.session.user.id),
    );
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function POST(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const { orgId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { confirmName, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof confirmName !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`confirmName` is required.' },
      { status: 400 },
    );
  }
  if (password !== undefined && typeof password !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`password` must be a string.' },
      { status: 400 },
    );
  }

  const limit = await consumeRateLimit(
    'account:org-deletion',
    [session.user.id],
    SCHEDULE_ATTEMPTS,
    SCHEDULE_WINDOW_MS,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { code: 'RATE_LIMITED', error: 'Too many attempts. Try again later.' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
      },
    );
  }

  try {
    const request = await organizationDeletionService.scheduleOrganizationDeletion({
      organizationId: orgId,
      actorUserId: session.user.id,
      confirmName,
      password,
      sessionSignedInAt: new Date(session.session.createdAt),
    });
    return NextResponse.json(request);
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { orgId } = await params;
  try {
    const { outcome } = await organizationDeletionService.cancelOrganizationDeletion({
      organizationId: orgId,
      actorUserId: gate.session.user.id,
    });
    return NextResponse.json({ outcome });
  } catch (err) {
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
