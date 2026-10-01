import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';

// `POST /api/projects/:key/instances/:id/update` — move the owner's agent to the newest published sandbox image, on the same machine and volume (`agent-image-update.md` Q2–Q8) (Story MOTIR-6862 · MOTIR-6952).

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  try {
    const instance = await agentInstanceLifecycleService.update(key, id, gate.ctx);
    return NextResponse.json({ instance });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
