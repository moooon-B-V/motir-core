import { NextResponse } from 'next/server';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/agent-runs/agents (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §4) — the caller's OWN agents on the
// card's project, each with its state, profile, launcher capability, last
// sign-in, the run it is running (if any) and why it cannot run this card (if it
// cannot): `200 { agents: AgentForCardDto[] }`. Another member's agent never
// appears (`agent-instances.md` §8). The card's agent picker (MOTIR-7028) reads it.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { id: key } = await params;
  try {
    const result = await agentInstanceRunService.listAgentsForCard(key, gate.ctx);
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
