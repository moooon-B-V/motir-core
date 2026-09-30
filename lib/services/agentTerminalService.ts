import {
  AgentInstanceNoTerminalServerError,
  AgentInstanceNotRunningError,
  AgentInstancesUnavailableError,
  AgentTerminalNotOwnerError,
} from '@/lib/agentInstances/errors';
import { terminalMasterKey } from '@/lib/agentInstances/terminal';
import {
  TERMINAL_TICKET_TTL_MS,
  addressForChannel,
  terminalRelayUrl,
  type AgentTerminalChannel,
} from '@/lib/agentTerminal/protocol';
import { hashTerminalTicket, mintTerminalTicket } from '@/lib/agentTerminal/ticket';
import type { AgentTerminalTicketDto } from '@/lib/dto/agentTerminal';
import { toAgentTerminalTicketDto } from '@/lib/mappers/agentTerminalMappers';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentTerminalTicketRepository } from '@/lib/repositories/agentTerminalTicketRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { agentTerminalClock } from '@/lib/services/agentTerminalRelayService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE AGENT TERMINAL'S TICKET (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3) — what the ticket route calls. The
// relay's half (redeem, re-read, dial target, connection rows, the sweep) is
// `agentTerminalRelayService`, kept apart because this file reaches
// `projectsService` → … → `lib/auth`, which the relay app cannot load.
//
// `issueTicket` checks, in order: `instance:use`; OWNERSHIP — the owner only,
// a manager refused like anyone else (`agent-instances.md` §8), and the same
// `not_owner` for an agent that does not exist, so nothing leaks; the image
// serving a terminal; the agent `running`. It never wakes anything: the panel
// calls the existing Wake route first (Q6), so waking stays in one place.
//
// THE CHANNEL (`agent-chat.md` Q4 · MOTIR-7013): a ticket names the socket it
// opens — `terminal` (the default) or `chat` — with the SAME checks for both, and
// is stored with it. The relay redeems it only on that channel's path. The chat
// server is the terminal server's own process, so an image without the terminal
// server has no chat either; an image with an older server is the relay's 4411.
//
// ⚠️ THE TICKET IS A CREDENTIAL. It exists in memory for one call, is returned
// to its owner once, and is stored only as its SHA-256. Nothing logs it.

function requireMasterKey(): void {
  if (!terminalMasterKey()) {
    throw new AgentInstancesUnavailableError('the agent terminal is not configured');
  }
}

export const agentTerminalService = {
  /**
   * `POST /api/projects/:key/instances/:id/terminal-ticket` — mint a 60-second,
   * single-use ticket for the caller's OWN running agent.
   *
   * Refusals: `PermissionDeniedError` (no `instance:use`), then
   * `AgentTerminalNotOwnerError` for an agent that is not the caller's — or does
   * not exist, or is deleted, one answer for all three — then
   * `AgentInstanceNoTerminalServerError`, then `AgentInstanceNotRunningError`.
   * `channel` is already validated by the route; it defaults to `terminal`.
   */
  async issueTicket(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
    channel: AgentTerminalChannel = 'terminal',
  ): Promise<AgentTerminalTicketDto> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    requireMasterKey();

    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id };
    const ticket = mintTerminalTicket();
    const now = agentTerminalClock.now();
    const expiresAt = new Date(now.getTime() + TERMINAL_TICKET_TTL_MS);
    // One transaction: the ownership read that gates the write, and the write.
    await withWorkspaceContext(scope, async (tx) => {
      const row = await agentInstanceRepository.findLiveForOwner(instanceId, ctx.userId, tx);
      if (!row || row.projectId !== project.id) throw new AgentTerminalNotOwnerError(instanceId);
      if (row.terminalServer === 'absent') throw new AgentInstanceNoTerminalServerError(row.id);
      if (row.state !== 'running') throw new AgentInstanceNotRunningError(row.id, row.state);
      await agentTerminalTicketRepository.create(
        {
          workspaceId: row.workspaceId,
          instanceId: row.id,
          userId: ctx.userId,
          tokenHash: hashTerminalTicket(ticket),
          channel,
          expiresAt,
        },
        tx,
      );
    });
    return toAgentTerminalTicketDto({
      url: addressForChannel(terminalRelayUrl(), channel),
      ticket,
      channel,
      expiresAt,
    });
  },
};
