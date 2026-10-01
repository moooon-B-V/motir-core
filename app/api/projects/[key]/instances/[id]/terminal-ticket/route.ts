import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import {
  AGENT_TERMINAL_CHANNELS,
  isAgentTerminalChannel,
  type AgentTerminalChannel,
} from '@/lib/agentTerminal/protocol';
import { agentTerminalService } from '@/lib/services/agentTerminalService';

// `POST /api/projects/:key/instances/:id/terminal-ticket` — a 60-second,
// single-use ticket for the caller's OWN running agent's terminal or chat
// (`docs/decisions/agent-terminal.md` Q3 · MOTIR-6940; `agent-chat.md` Q4 ·
// MOTIR-7013). Body `{ "channel": "terminal" | "chat" }`, optional: no body, or
// no `channel`, is a terminal ticket exactly as before; any other channel is a
// 400. Answers `{ url, ticket, channel, expiresAt }`; refuses `not_owner` 403
// (also for an agent that does not exist — no existence leak), `not_running`
// 409, `no_terminal_server` 409. The session to resume travels in the browser's
// `open` frame, never here. The ticket is never logged.

const badRequest = () =>
  NextResponse.json(
    {
      code: 'BAD_REQUEST',
      error: `Send no body, or a \`channel\` of ${AGENT_TERMINAL_CHANNELS.map((c) => `"${c}"`).join(' or ')}.`,
    },
    { status: 400 },
  );

/** The requested channel, `terminal` when none is named, or null for a bad request. */
async function readChannel(req: Request): Promise<AgentTerminalChannel | null> {
  const text = await req.text();
  if (text.trim() === '') return 'terminal';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const channel = (body as { channel?: unknown }).channel;
  if (channel === undefined) return 'terminal';
  return isAgentTerminalChannel(channel) ? channel : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string; id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key, id } = await params;
  const channel = await readChannel(req);
  if (!channel) return badRequest();
  try {
    const ticket = await agentTerminalService.issueTicket(key, id, gate.ctx, channel);
    return NextResponse.json(ticket, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
