// THE CHAT WIRE PROTOCOL, AS THE BROWSER READS IT (Story MOTIR-6863 · MOTIR-7017)
// — the web app's mirror of `packages/cli/src/agentTerminal/chat/protocol.ts`
// (MOTIR-7012), `docs/decisions/agent-chat.md` Q4 and Q5.
//
// ⚠️ A MIRROR, NEVER AN IMPORT. `app/` and `lib/` do not import
// `packages/cli/**` (`tests/agentTerminal/agentTerminalStoryGate.test.ts`), so the
// shapes are written again here. `tests/agentChat/protocolMirror.test.ts` reads
// the CLI file's source text and fails when either side gains a frame, an event
// kind, a tool kind, a turn-end reason or an error code the other lacks.
//
// Pure and dependency-free (the heartbeat bytes are the relay's own constants),
// so the hook, the transcript and the tests share one spelling.

export { CHAT_PING_ACTIVE, CHAT_PING_INACTIVE, CHAT_PONG } from '@/lib/agentTerminal/protocol';

/** The largest prompt a `prompt` frame may carry, in UTF-8 bytes (Q4). */
export const MAX_PROMPT_BYTES = 64 * 1024;
/** A `tool_result.output` or a `diff` arrives cut to its last 64 KiB (Q5). */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
/** Q7: the session list holds at most this many, newest first. */
export const MAX_LISTED_SESSIONS = 50;
/** Q4/Q9: the heartbeat interval, the terminal's. */
export const CHAT_PING_MS = 20_000;

/** The Q4 refusal codes, carried by an `error` frame. */
export const CHAT_ERROR_CODES = [
  'unsupported',
  'subscription_signin',
  'not_signed_in',
  'turn_running',
  'no_turn',
  'unknown_session',
  'taken_over',
  'too_large',
  'bad_frame',
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** Why a profile cannot chat: Q1's verdict, or Q2's sign-in rule. */
export type ChatRefusal = Extract<ChatErrorCode, 'unsupported' | 'subscription_signin'>;

/** The terminal's sign-in states (`agent-terminal.md` Q7), carried by `hello` and `signin`. */
export const CHAT_SIGN_IN_STATES = ['signed_in', 'signed_out', 'unknown'] as const;
export type ChatSignInState = (typeof CHAT_SIGN_IN_STATES)[number];

// ── The transcript (Q5) ─────────────────────────────────────────────────────

export const TOOL_KINDS = ['read', 'edit', 'command', 'other'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const TURN_END_REASONS = ['completed', 'stopped', 'failed'] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

/** The runner's own `failed` codes; an adapter may also end a turn with a Q4 code. */
export const TURN_FAIL_CODES = ['spawn_failed', 'exit_nonzero', 'no_end', 'shutdown'] as const;
export type TurnFailCode = (typeof TURN_FAIL_CODES)[number] | ChatErrorCode;

export const TRANSCRIPT_EVENT_KINDS = [
  'user',
  'text',
  'tool_call',
  'tool_result',
  'turn_end',
  'error',
  'other',
] as const;
export type TranscriptEventKind = (typeof TRANSCRIPT_EVENT_KINDS)[number];

export type TranscriptEvent =
  | { k: 'user'; text: string }
  | { k: 'text'; id: string; delta: string }
  | {
      k: 'tool_call';
      id: string;
      kind: ToolKind;
      name: string;
      title: string;
      path?: string;
      command?: string;
      diff?: string;
    }
  | {
      k: 'tool_result';
      id: string;
      ok: boolean;
      output?: string;
      exitCode?: number;
      truncated: boolean;
    }
  | { k: 'turn_end'; reason: TurnEndReason; code?: TurnFailCode }
  | { k: 'error'; code: string; message?: string }
  | { k: 'other'; name: string };

/** One row of Q7's list. `updatedAt` is an ISO 8601 time. */
export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

// ── Frames (Q4) ─────────────────────────────────────────────────────────────

export const CHAT_CLIENT_FRAME_TYPES = ['list', 'open', 'prompt', 'stop', 'ping'] as const;
export type ChatClientFrameType = (typeof CHAT_CLIENT_FRAME_TYPES)[number];

export const CHAT_SERVER_FRAME_TYPES = [
  'hello',
  'sessions',
  'ready',
  'history',
  'session',
  'event',
  'pong',
  'signin',
  'error',
] as const;
export type ChatServerFrameType = (typeof CHAT_SERVER_FRAME_TYPES)[number];

export type ChatClientFrame =
  | { t: 'list' }
  | { t: 'open'; session?: string }
  | { t: 'prompt'; text: string }
  | { t: 'stop' }
  | { t: 'ping'; active: boolean };

export type ChatServerFrame =
  | {
      t: 'hello';
      profile: string | null;
      supported: boolean;
      reason?: ChatRefusal;
      signin: ChatSignInState;
    }
  | { t: 'sessions'; items: ChatSessionSummary[] }
  | { t: 'ready'; session: string | null; resumed: boolean }
  | { t: 'history'; events: TranscriptEvent[]; truncated: boolean }
  | { t: 'session'; id: string }
  | { t: 'event'; turn: number; e: TranscriptEvent }
  | { t: 'pong' }
  | { t: 'signin'; profile: string | null; state: ChatSignInState }
  | { t: 'error'; code: ChatErrorCode };

// ── Reading what the server sent ────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string';
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Is this a transcript event the tab knows how to draw? Anything else is dropped. */
export function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  if (!isObj(value)) return false;
  switch (value['k']) {
    case 'user':
      return isStr(value['text']);
    case 'text':
      return isStr(value['id']) && isStr(value['delta']);
    case 'tool_call':
      return (
        isStr(value['id']) &&
        oneOf(TOOL_KINDS, value['kind']) &&
        isStr(value['name']) &&
        isStr(value['title']) &&
        optStr(value['path']) &&
        optStr(value['command']) &&
        optStr(value['diff'])
      );
    case 'tool_result':
      return (
        isStr(value['id']) &&
        typeof value['ok'] === 'boolean' &&
        optStr(value['output']) &&
        (value['exitCode'] === undefined || typeof value['exitCode'] === 'number') &&
        typeof value['truncated'] === 'boolean'
      );
    case 'turn_end':
      return oneOf(TURN_END_REASONS, value['reason']) && optStr(value['code']);
    case 'error':
      return isStr(value['code']) && optStr(value['message']);
    case 'other':
      return isStr(value['name']);
    default:
      return false;
  }
}

function isSession(value: unknown): value is ChatSessionSummary {
  return isObj(value) && isStr(value['id']) && isStr(value['title']) && isStr(value['updatedAt']);
}

/**
 * Parse one server frame, or null for anything that is not a well-formed frame
 * of a known type. A malformed frame is dropped silently — never logged (Q10).
 */
export function parseChatServerFrame(text: string): ChatServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(value)) return null;
  switch (value['t']) {
    case 'hello': {
      if (typeof value['supported'] !== 'boolean') return null;
      const signin = oneOf(CHAT_SIGN_IN_STATES, value['signin']) ? value['signin'] : 'unknown';
      const reason =
        value['reason'] === 'unsupported' || value['reason'] === 'subscription_signin'
          ? value['reason']
          : undefined;
      return {
        t: 'hello',
        profile: isStr(value['profile']) ? value['profile'] : null,
        supported: value['supported'],
        ...(reason ? { reason } : {}),
        signin,
      };
    }
    case 'sessions': {
      const items = value['items'];
      if (!Array.isArray(items)) return null;
      return { t: 'sessions', items: items.filter(isSession) };
    }
    case 'ready':
      return {
        t: 'ready',
        session: isStr(value['session']) ? value['session'] : null,
        resumed: value['resumed'] === true,
      };
    case 'history': {
      const events = value['events'];
      if (!Array.isArray(events)) return null;
      return {
        t: 'history',
        events: events.filter(isTranscriptEvent),
        truncated: value['truncated'] === true,
      };
    }
    case 'session':
      return isStr(value['id']) ? { t: 'session', id: value['id'] } : null;
    case 'event':
      if (typeof value['turn'] !== 'number' || !isTranscriptEvent(value['e'])) return null;
      return { t: 'event', turn: value['turn'], e: value['e'] };
    case 'pong':
      return { t: 'pong' };
    case 'signin':
      if (!oneOf(CHAT_SIGN_IN_STATES, value['state'])) return null;
      return {
        t: 'signin',
        profile: isStr(value['profile']) ? value['profile'] : null,
        state: value['state'],
      };
    case 'error':
      return oneOf(CHAT_ERROR_CODES, value['code']) ? { t: 'error', code: value['code'] } : null;
    default:
      return null;
  }
}

/** A client frame as its wire text. */
export function encodeChatClientFrame(frame: ChatClientFrame): string {
  return JSON.stringify(frame);
}

/** A prompt's size on the wire, in UTF-8 bytes. */
export function promptBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
