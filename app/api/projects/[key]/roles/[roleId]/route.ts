import { NextResponse } from 'next/server';

// /api/projects/[key]/roles/[roleId] — RETIRED (Story MOTIR-6168 · MOTIR-6464).
//
// A project custom role is no longer a grant, so there is nothing to rename,
// re-permission or delete here: the workspace's own roles are edited at
// `/api/workspaces/{workspaceId}/roles/{roleId}`. Kept as a 410 so a stale client
// learns where the role went instead of reading a 404.

const GONE = {
  error:
    'Project roles are retired: roles are edited on the workspace and hold in every project. ' +
    'Use PATCH or DELETE /api/workspaces/{workspaceId}/roles/{roleId}.',
  code: 'project_roles_retired',
} as const;

export async function PATCH(): Promise<Response> {
  return NextResponse.json(GONE, { status: 410 });
}

export async function DELETE(): Promise<Response> {
  return NextResponse.json(GONE, { status: 410 });
}
