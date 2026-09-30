import type { AgentTerminalTicketDto } from '@/lib/dto/agentTerminal';

// Row → DTO for the agent terminal's ticket (Story MOTIR-6861 · MOTIR-6940). The
// ticket itself is passed in: the row holds only its hash.

export function toAgentTerminalTicketDto(input: {
  url: string;
  ticket: string;
  expiresAt: Date;
}): AgentTerminalTicketDto {
  return { url: input.url, ticket: input.ticket, expiresAt: input.expiresAt.toISOString() };
}
