import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';

// GET `/api/projects/:key/instances/:id/boot` — the caller's agent's CURRENT boot
// attempt and its steps (Story MOTIR-7393 · MOTIR-7399, `agent-instances.md`
// AMENDMENT 6 §6). `{ boot: null }` for an agent that never booted under the
// boot driver. Owner-only: anything else answers the instance read's 404.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  try {
    const boot = await agentInstanceBootService.readBoot(key, id, gate.ctx);
    return NextResponse.json({ boot });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
