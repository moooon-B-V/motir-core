import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';

// `POST /api/projects/:key/instances/:id/hibernate` — hibernate a running instance (`agent-instances.md` §2) (Story MOTIR-6860 · MOTIR-6872).

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  try {
    const instance = await agentInstanceLifecycleService.hibernate(key, id, gate.ctx);
    return NextResponse.json({ instance });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
