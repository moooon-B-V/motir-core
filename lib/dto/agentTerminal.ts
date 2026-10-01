import type { AgentTerminalChannel } from '@/lib/agentTerminal/protocol';

// The AGENT TERMINAL DTOs (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3; the channel is `agent-chat.md` Q4 ·
// MOTIR-7013).

/**
 * What the ticket route returns to the owner's browser: where the relay is, the
 * one-shot ticket to send as the first frame (`{"t":"auth","ticket"}`), the
 * channel it opens, and when it stops being redeemable. The ticket is shown to
 * its owner once and stored nowhere but as its hash.
 */
export interface AgentTerminalTicketDto {
  /**
   * The relay's WebSocket address for this ticket's channel: `MOTIR_RELAY_URL`
   * (default `wss://relay.motir.co/v1/terminal`), its path moved to `/v1/chat`
   * for a chat ticket.
   */
  url: string;
  /** base64url of 32 random bytes. */
  ticket: string;
  /** The socket the ticket opens — redeemed on that channel's path only. */
  channel: AgentTerminalChannel;
  /** ISO-8601; 60 seconds after it was minted. */
  expiresAt: string;
}
