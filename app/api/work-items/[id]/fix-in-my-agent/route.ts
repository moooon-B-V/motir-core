import { NextResponse } from 'next/server';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { fixInMyAgentService } from '@/lib/services/fixInMyAgentService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/fix-in-my-agent (Story MOTIR-8981 · MOTIR-9053) — the
// "Fix in my agent" door's state for one card: `200 FixInMyAgentDoorDto`. Not offered is
// an ANSWER (`offered: false` + a reason), never an error status; only a caller who may
// not browse the card is refused (404, no existence leak).

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;
  try {
    const result = await fixInMyAgentService.readDoor(key, gate.ctx);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    if (
      (err instanceof ProjectAccessDeniedError && err.kind === 'browse') ||
      err instanceof WorkItemNotFoundError
    ) {
      return NextResponse.json(
        { code: 'WORK_ITEM_NOT_FOUND', error: 'Not found.' },
        { status: 404, headers: NO_STORE },
      );
    }
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
