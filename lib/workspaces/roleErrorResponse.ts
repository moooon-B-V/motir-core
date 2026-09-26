import { NextResponse } from 'next/server';
import {
  NotAMemberError,
  WorkspaceRoleForbiddenError,
  WorkspaceRoleInUseError,
  WorkspaceRoleNameTakenError,
} from '@/lib/workspaces/errors';
import {
  BuiltInRoleImmutableError,
  InvalidRoleNameError,
  InvalidRoleReassignTargetError,
  RoleDefinitionNotFoundError,
  UngrantablePermissionError,
} from '@/lib/permissions/errors';

// Typed workspace-role errors → HTTP (Story MOTIR-6168 · MOTIR-6460), shared by
// the two `/api/workspaces/[workspaceId]/roles` routes. A workspace the actor
// cannot see and a role that is not this workspace's are both 404, so neither
// confirms that a foreign id exists; a member who is not a Manager is 403.
export function workspaceRoleErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof NotAMemberError || err instanceof RoleDefinitionNotFoundError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
  }
  if (err instanceof WorkspaceRoleForbiddenError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof BuiltInRoleImmutableError) {
    return NextResponse.json(
      { error: err.message, code: err.code, role: err.role },
      { status: 403 },
    );
  }
  if (err instanceof WorkspaceRoleInUseError) {
    return NextResponse.json(
      { error: err.message, code: err.code, count: err.count, roleName: err.roleName },
      { status: 409 },
    );
  }
  if (err instanceof WorkspaceRoleNameTakenError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
  }
  if (
    err instanceof InvalidRoleNameError ||
    err instanceof UngrantablePermissionError ||
    err instanceof InvalidRoleReassignTargetError
  ) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
  }
  return null;
}
