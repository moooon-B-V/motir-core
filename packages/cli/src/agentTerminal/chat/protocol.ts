import type { SignInState } from '../protocol.js';

// The chat wire protocol (MOTIR-7012 · `docs/decisions/agent-chat.md` Q4, Q5),
// one WebSocket per open chat view at `/v1/chat`, behind the same relay token
// as the terminal. ALL frames are JSON text; there are no binary frames.
//
//   server → client  {"t":"hello","profile","supported","reason"?,"signin"}  the first server frame
//   client → server  {"t":"list"}                                           ask for the session list
//   server → client  {"t":"sessions","items":[{"id","title","updatedAt"}]}  Q7's list
//   client → server  {"t":"open","session"?}                                a new chat, or resume `session`
//   server → client  {"t":"ready","session","resumed"}                      attached (`session` null until known)
//   server → client  {"t":"history","events","truncated"}                   a resume's earlier turns
//   client → server  {"t":"prompt","text"}                                  start a turn (1 B – 64 KiB)
//   server → client  {"t":"session","id"}                                   the CLI's session id, once known
//   server → client  {"t":"event","turn","e"}                               one transcript event, in order
//   client → server  {"t":"stop"}                                           stop the running turn
//   client → server  {"t":"ping","active"} · server → client {"t":"pong"}   the terminal's heartbeat
//   server → client  {"t":"signin","profile","state"}                       the sign-in state on change
//   server → client  {"t":"error","code"}                                   a refusal; the socket stays open
//
// Pure: no I/O, so the adapters, the relay and the panel can read the same
// shapes.

/** The largest prompt a `prompt` frame may carry, in UTF-8 bytes (Q4). */
export const MAX_PROMPT_BYTES = 64 * 1024;
/** A `tool_result.output` or a `diff` is cut to its last 64 KiB (Q5). */
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

/** The Q4 refusal codes, carried by an `error` frame. */
export type ChatErrorCode =
  | 'unsupported'
  | 'subscription_signin'
  | 'not_signed_in'
  | 'turn_running'
  | 'no_turn'
  | 'unknown_session'
  | 'taken_over'
  | 'too_large'
  | 'bad_frame';

/** Why a profile cannot chat: Q1's verdict, or Q2's sign-in rule. */
export type ChatRefusal = Extract<ChatErrorCode, 'unsupported' | 'subscription_signin'>;

// ── The transcript (Q5) ─────────────────────────────────────────────────────

export type ToolKind = 'read' | 'edit' | 'command' | 'other';

export type TurnEndReason = 'completed' | 'stopped' | 'failed';

/**
 * Why a turn ended `failed`. The runner's own codes, or the code an adapter
 * asked a kill with (Q2's `subscription_signin` backstop).
 *
 *   spawn_failed   the process could not be started (or its command was refused)
 *   exit_nonzero   it exited non-zero, or on a signal nobody sent
 *   no_end         it exited 0 without the adapter's end marker
 *   shutdown       the server closed under it
 */
export type TurnFailCode = 'spawn_failed' | 'exit_nonzero' | 'no_end' | 'shutdown' | ChatErrorCode;

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
      signin: SignInState;
    }
  | { t: 'sessions'; items: ChatSessionSummary[] }
  | { t: 'ready'; session: string | null; resumed: boolean }
  | { t: 'history'; events: TranscriptEvent[]; truncated: boolean }
  | { t: 'session'; id: string }
  | { t: 'event'; turn: number; e: TranscriptEvent }
  | { t: 'pong' }
  | { t: 'signin'; profile: string | null; state: SignInState }
  | { t: 'error'; code: ChatErrorCode };

export type ParsedChatFrame =
  | { ok: true; frame: ChatClientFrame }
  | { ok: false; code: Extract<ChatErrorCode, 'bad_frame' | 'too_large'> };

/**
 * A session id the server will hand to an adapter. It reaches a vendor's argv
 * (`--resume <id>`) and may name a file in its store, so it is held to the
 * characters every supported CLI's ids use: no leading `-` (an option), no `/`
 * and no `..` (a path).
 */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value) && !value.includes('..');
}

/**
 * Parse one text frame. A malformed frame answers `bad_frame` and a prompt over
 * 64 KiB `too_large`; neither echoes any of the frame back.
 */
export function parseChatClientFrame(text: string): ParsedChatFrame {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad_frame' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'bad_frame' };
  }
  const frame = value as Record<string, unknown>;
  switch (frame['t']) {
    case 'list':
      return { ok: true, frame: { t: 'list' } };
    case 'stop':
      return { ok: true, frame: { t: 'stop' } };
    case 'ping':
      return { ok: true, frame: { t: 'ping', active: frame['active'] === true } };
    case 'open': {
      const session = frame['session'];
      if (session === undefined || session === null) return { ok: true, frame: { t: 'open' } };
      if (typeof session !== 'string' || session.length === 0) {
        return { ok: false, code: 'bad_frame' };
      }
      return { ok: true, frame: { t: 'open', session } };
    }
    case 'prompt': {
      const promptText = frame['text'];
      if (typeof promptText !== 'string' || promptText.length === 0) {
        return { ok: false, code: 'bad_frame' };
      }
      if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) {
        return { ok: false, code: 'too_large' };
      }
      return { ok: true, frame: { t: 'prompt', text: promptText } };
    }
    default:
      return { ok: false, code: 'bad_frame' };
  }
}

export function encodeChatServerFrame(frame: ChatServerFrame): string {
  return JSON.stringify(frame);
}

/**
 * The last `maxBytes` of a text, cut on a character boundary (Q5's bound on a
 * tool output and a diff). Adapters call it; the runner applies it again to
 * every event, so no frame nears the 1 MiB cap whatever an adapter does.
 */
export function boundTail(
  text: string,
  maxBytes: number = MAX_TOOL_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  // Step past UTF-8 continuation bytes so the cut never splits a character.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

/** An event with its tool output and diff held to Q5's bound. */
export function boundEvent(event: TranscriptEvent): TranscriptEvent {
  if (event.k === 'tool_result' && event.output !== undefined) {
    const bounded = boundTail(event.output);
    if (!bounded.truncated) return event;
    return { ...event, output: bounded.text, truncated: true };
  }
  if (event.k === 'tool_call' && event.diff !== undefined) {
    const bounded = boundTail(event.diff);
    if (!bounded.truncated) return event;
    return { ...event, diff: bounded.text };
  }
  return event;
}
