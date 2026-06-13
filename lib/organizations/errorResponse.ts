import { NextResponse } from 'next/server';
import {
  AlreadyOrgMemberError,
  LastOrgOwnerError,
  OrganizationNotFoundError,
  OrgForbiddenError,
  OrgInviteeNotFoundError,
  OrgSlugCollisionError,
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
  if (err instanceof LastOrgOwnerError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof OrgSlugCollisionError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  return null;
}
