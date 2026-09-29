import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';

// `/api/projects/:key/instances/:id` — DELETE one of the caller's own instances
// and its home (Story MOTIR-6860 · MOTIR-6872, `agent-instances.md` §1, §4).

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  try {
    await agentInstanceLifecycleService.delete(key, id, gate.ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
