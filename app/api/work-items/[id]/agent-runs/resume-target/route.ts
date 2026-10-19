import { NextResponse } from 'next/server';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/agent-runs/resume-target (Story MOTIR-8981 · MOTIR-9046)
// — the card's LAST run read back: which agent it ran in, the session id its leg
// recorded and whether that agent's profile has a resume form:
// `200 { lastRun: CardRunResumeTargetDto | null }`. The "Fix in my agent" door and
// the resume read it. A caller without `instance:use` gets `{ lastRun: null }`.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;
  try {
    const result = await agentInstanceRunService.resumeTargetForCard(key, gate.ctx);
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
