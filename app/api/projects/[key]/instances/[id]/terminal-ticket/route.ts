import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentTerminalService } from '@/lib/services/agentTerminalService';

// `POST /api/projects/:key/instances/:id/terminal-ticket` — a 60-second,
// single-use ticket for the caller's OWN running agent's terminal
// (`docs/decisions/agent-terminal.md` Q3 · MOTIR-6940). No body. Answers
// `{ url, ticket, expiresAt }`; refuses `not_owner` 403 (also for an agent that
// does not exist — no existence leak), `not_running` 409, `no_terminal_server`
// 409. The session to resume travels in the browser's `open` frame, never here.
// The ticket is never logged.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  try {
    const ticket = await agentTerminalService.issueTicket(key, id, gate.ctx);
    return NextResponse.json(ticket, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
