// The AGENT TERMINAL DTOs (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3).

/**
 * What the ticket route returns to the owner's browser: where the relay is, the
 * one-shot ticket to send as the first frame (`{"t":"auth","ticket"}`), and when
 * it stops being redeemable. The ticket is shown to its owner once and stored
 * nowhere but as its hash.
 */
export interface AgentTerminalTicketDto {
  /** The relay's WebSocket address, `MOTIR_RELAY_URL` (default `wss://relay.motir.co/v1/terminal`). */
  url: string;
  /** base64url of 32 random bytes. */
  ticket: string;
  /** ISO-8601; 60 seconds after it was minted. */
  expiresAt: string;
}
