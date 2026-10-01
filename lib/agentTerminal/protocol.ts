// THE TERMINAL RELAY'S NUMBERS AND WORDS (Story MOTIR-6861 · MOTIR-6940),
// `docs/decisions/agent-terminal.md` Q3 and Q6, named once. Dependency-free, so
// the ticket route, the relay and the tests share one spelling.

/** Q3: the WebSocket path, on the relay and on the agent's terminal server. */
export const TERMINAL_PATH = '/v1/terminal';

/**
 * `agent-chat.md` Q4 (MOTIR-7013): the chat's WebSocket path, on the relay and on
 * the agent's own server (the same process and port as the terminal).
 */
export const CHAT_PATH = '/v1/chat';

/**
 * `agent-chat.md` Q4: which of the agent's two sockets a ticket opens. The
 * ticket and the connection row record it; the relay redeems a ticket only on
 * its own channel's path, so a terminal ticket can never open a chat, nor the
 * reverse.
 */
export const AGENT_TERMINAL_CHANNELS = ['terminal', 'chat'] as const;
export type AgentTerminalChannel = (typeof AGENT_TERMINAL_CHANNELS)[number];

/** Is this a channel a ticket may name? */
export function isAgentTerminalChannel(value: unknown): value is AgentTerminalChannel {
  return (
    typeof value === 'string' && (AGENT_TERMINAL_CHANNELS as readonly string[]).includes(value)
  );
}

/** Each channel's WebSocket path — the same on the relay and on the machine. */
export const CHANNEL_PATH: Readonly<Record<AgentTerminalChannel, string>> = {
  terminal: TERMINAL_PATH,
  chat: CHAT_PATH,
};

/** The channel a relay path serves, or null for a path the relay does not serve. */
export function channelForPath(path: string): AgentTerminalChannel | null {
  if (path === TERMINAL_PATH) return 'terminal';
  if (path === CHAT_PATH) return 'chat';
  return null;
}

/**
 * A terminal address (`…/v1/terminal`, as the orchestrator and `MOTIR_RELAY_URL`
 * spell it) moved to `channel`'s path. The terminal's is returned unchanged; for
 * the chat, a trailing `/v1/terminal` becomes `/v1/chat` — any host and prefix
 * before it are kept — and an address without that suffix gets `/v1/chat`
 * appended.
 */
export function addressForChannel(terminalAddress: string, channel: AgentTerminalChannel): string {
  if (channel === 'terminal') return terminalAddress;
  const base = terminalAddress.endsWith(TERMINAL_PATH)
    ? terminalAddress.slice(0, -TERMINAL_PATH.length)
    : terminalAddress.replace(/\/+$/, '');
  return `${base}${CHAT_PATH}`;
}

/**
 * `agent-chat.md` Q9: THE HEARTBEAT BYTES. On the chat channel the relay decodes
 * no frame after `auth`; it tells a heartbeat by comparing a frame's bytes to
 * these constants, which the panel and the agent's server send exactly. Every
 * other chat frame, in either direction, counts as activity.
 */
/** A visible tab's heartbeat — counts. */
export const CHAT_PING_ACTIVE = '{"t":"ping","active":true}';
/** A hidden tab's heartbeat — does NOT count. */
export const CHAT_PING_INACTIVE = '{"t":"ping","active":false}';
/** The server's answer to either ping — does NOT count. */
export const CHAT_PONG = '{"t":"pong"}';

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
  /**
   * The agent's image has no chat server (`agent-chat.md` Q8, MOTIR-7013): its
   * server answered the chat dial with HTTP 404. The chat channel only.
   */
  noChatServer: 4411,
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
  /** The chat dial got HTTP 404: the agent's image predates the chat server (4411). */
  | 'no_chat_server'
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
