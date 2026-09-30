// THE TERMINAL RELAY'S NUMBERS AND WORDS (Story MOTIR-6861 · MOTIR-6940),
// `docs/decisions/agent-terminal.md` Q3 and Q6, named once. Dependency-free, so
// the ticket route, the relay and the tests share one spelling.

/** Q3: the WebSocket path, on the relay and on the agent's terminal server. */
export const TERMINAL_PATH = '/v1/terminal';

/** Q1/Q3: where the browser dials when `MOTIR_RELAY_URL` is unset. */
export const DEFAULT_RELAY_URL = 'wss://relay.motir.co/v1/terminal';

/** Q3: a ticket lives 60 seconds. */
export const TERMINAL_TICKET_TTL_MS = 60_000;

/** Q3: the browser's first frame must arrive within 5 seconds. */
export const TERMINAL_AUTH_TIMEOUT_MS = 5_000;

/** Q6: protocol-level WebSocket pings to both sides, every 20 seconds. */
export const TERMINAL_PING_INTERVAL_MS = 20_000;

/** Q6: at most one activity bump per instance per relay process per minute. */
export const TERMINAL_ACTIVITY_THROTTLE_MS = 60_000;

/**
 * MOTIR-6959: how often a relay refreshes `lastSeenAt` on the connection rows it
 * holds — one timer per relay process, not per connection.
 */
export const TERMINAL_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * MOTIR-6959: an open connection row whose relay has not refreshed it for this
 * long belongs to a relay that died without shutting down; the sweep closes it
 * `relay_lost`. Five missed heartbeats, so a slow database write is never mistaken
 * for a dead relay.
 */
export const TERMINAL_CONNECTION_LOST_AFTER_MS = 5 * 60_000;

/**
 * Q3's refusal table — the close codes the panel maps to words. The numbers are
 * the contract with MOTIR-6941; never renumber one.
 */
export const TERMINAL_CLOSE = {
  /** The ticket is invalid, expired or already used (or never arrived in time). */
  badTicket: 4401,
  /** The user does not own this agent (or the page's Origin is not Motir's). */
  notOwner: 4403,
  /** The agent is not running. */
  notRunning: 4409,
  /** The agent's image has no terminal server. */
  noTerminalServer: 4410,
  /** The machine did not answer. */
  unreachable: 4502,
} as const;

export type TerminalRefusalCode = (typeof TERMINAL_CLOSE)[keyof typeof TERMINAL_CLOSE];

/**
 * Why a connection closed, as recorded on `agent_terminal_connection`. Words for
 * a person reading the table — never anything that flowed through it.
 */
export type AgentTerminalCloseReason =
  /** The browser closed its socket. */
  | 'browser_closed'
  /** The agent's terminal server closed its socket (a shell exit, a refusal, a restart). */
  | 'terminal_closed'
  /** The machine could not be reached, or dropped the connection. */
  | 'unreachable'
  /** A peer stopped answering protocol pings. */
  | 'ping_timeout'
  /** The relay is shutting down (a deploy). */
  | 'relay_shutdown'
  /** The browser broke the protocol (a frame too large, too many before the dial). */
  | 'protocol_error'
  /**
   * The relay holding the connection died without shutting down (MOTIR-6959):
   * closed by the sweep or by that machine's next boot, at its last heartbeat.
   */
  | 'relay_lost';

/** The relay URL the ticket route hands out: `MOTIR_RELAY_URL`, read at call time. */
export function terminalRelayUrl(): string {
  const configured = process.env['MOTIR_RELAY_URL']?.trim();
  return configured ? configured : DEFAULT_RELAY_URL;
}
