import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectStatusAutomationService } from '@/lib/services/projectStatusAutomationService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import type { UpdateProjectStatusAutomationInput } from '@/lib/dto/projectStatusAutomation';

// GET / PATCH /api/projects/[key]/status-automation (Story MOTIR-1615 · Subtask
// MOTIR-1618) — read or admin-update a project's bidirectional status-derivation
// switches: the upward parent rollup and the downward child cascade
// (`docs/decisions/status-derivation.md`). The HTTP surface for the MOTIR-1618
// service, which is its single entry point: no route touches Prisma for these
// fields.
//
// Thin transport per CLAUDE.md — read the session context, call ONE service
// method, map typed errors. The service resolves the project by its
// workspace-unique `key` itself (alias-blind, tenant-scoped), so a cross-workspace
// or never-existed key reads as a 404 with no existence leak.
//
// Typed errors → status codes (all via the shared `projectErrorResponse`):
//   ProjectNotFoundError                     → 404 (missing / cross-tenant /
//                                                   non-browsable)
//   NotProjectAdminError                     → 403 (PATCH — a member may READ but
//                                                   not change)
//   InvalidStatusAutomationSettingsError     → 422 (a non-boolean switch; the body
//                                                   carries `field` so the panel
//                                                   can slot the message under the
//                                                   offending control)

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { key } = await params;

  try {
    const settings = await projectStatusAutomationService.getStatusAutomation(key, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // Forward only the PRESENT keys — the patch is partial by contract (an absent
  // field is left untouched), and the service owns every value check, so the
  // route stays a transport. `in` (not a truthiness test) so `false` is forwarded
  // rather than dropped — which for a pair of off-switches is the whole point.
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateProjectStatusAutomationInput = {};
  if ('autoRollupParentStatus' in raw) {
    patch.autoRollupParentStatus = raw.autoRollupParentStatus as boolean;
  }
  if ('autoCompleteChildrenOnParentDone' in raw) {
    patch.autoCompleteChildrenOnParentDone = raw.autoCompleteChildrenOnParentDone as boolean;
  }

  try {
    const settings = await projectStatusAutomationService.updateStatusAutomation(key, patch, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
