import { NextResponse } from 'next/server';

// /api/projects/[key]/roles — RETIRED (Story MOTIR-6168 · MOTIR-6464).
//
// Roles live on the workspace now (`docs/decisions/role-model.md` §2–§3): a
// person holds one role there, the same in every project, and a custom role is
// authored at `/api/workspaces/{workspaceId}/roles`. The handler is kept as a
// 410 rather than deleted so a stale client reads where the role went, not a 404.

const GONE = {
  error:
    'Project roles are retired: roles are authored on the workspace and hold in every project. ' +
    'Use POST /api/workspaces/{workspaceId}/roles.',
  code: 'project_roles_retired',
} as const;

export async function POST(): Promise<Response> {
  return NextResponse.json(GONE, { status: 410 });
}
