import { NextResponse } from 'next/server';
import {
  AlreadyOrgMemberError,
  InvalidOwnershipTargetError,
  OwnershipChangedError,
  OwnershipConfirmationMismatchError,
  OrganizationNotFoundError,
  OrgForbiddenError,
  OrgInviteeNotFoundError,
  OrgSlugCollisionError,
  OwnerMembershipLockedError,
  OwnerOnlyByTransferError,
  OrganizationClosingError,
} from '@/lib/organizations/errors';

// Typed-error → HTTP-status mapper for the organization routes (Story 6.10.5),
// mirroring lib/dashboards/errorResponse.ts. The route layer is HTTP-only
// (CLAUDE.md § 4-layer): it calls one service method, then hands any thrown
// error here. Returns a NextResponse for a known domain error, or null so the
// route rethrows (a genuine 500 the platform logs) — never swallow the unknown.
//
// The cross-tenant posture (the no-leak rule): a non-member of the org gets
// OrganizationNotFoundError → 404, indistinguishable from a non-existent org. A
// member who lacks org-admin rights gets OrgForbiddenError → 403 (the org IS
// visible to them, they just can't operate it).
export function mapOrgError(err: unknown): NextResponse | null {
  if (err instanceof OrganizationNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof OrgForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof OrgInviteeNotFoundError) {
    // The invited email has no Motir account — a client-correctable input, so
    // 422 (not 404, which the no-leak rule reserves for a hidden org).
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  if (err instanceof AlreadyOrgMemberError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof OwnerOnlyByTransferError || err instanceof OwnerMembershipLockedError) {
    // Both are the one-Owner invariant (MOTIR-6307): the request is well-formed,
    // it conflicts with the organization's state — exactly one Owner, whose row
    // moves only by transfer.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof InvalidOwnershipTargetError) {
    // The transfer target is a client-correctable input (not a member, or the
    // Owner themselves) — 422, carrying WHICH so the dialog can say it.
    return NextResponse.json(
      { code: err.code, reason: err.reason, error: err.message },
      { status: 422 },
    );
  }
  if (err instanceof OwnershipChangedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof OwnershipConfirmationMismatchError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof OrganizationClosingError) {
    // Read-only while the org is scheduled for deletion (MOTIR-6396) — a state a
    // cancel undoes, so a conflict rather than a permission refusal.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof OrgSlugCollisionError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  return null;
}
