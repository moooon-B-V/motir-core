// The terminal wire protocol (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q4), one WebSocket per terminal at `/v1/terminal`.
//
//   binary frames   terminal bytes, both ways
//   text frames     JSON control, the table below
//
//   client → server  {"t":"open","cols","rows","session"?}   attach: new, or resume `session`
//   client → server  {"t":"resize","cols","rows"}            resize the PTY
//   client → server  {"t":"ping","active"}                   heartbeat (every 20 s)
//   server → client  {"t":"ready","session","resumed"}       attached; on resume the replay follows
//                    (+ "kind":"run","runId" when the session is a run's)
//   server → client  {"t":"sessions","sessions":[{"session","kind","runId"?}]}
//                                                           every live session — on attach while a run
//                                                           session is live, and to every attached
//                                                           connection when one opens or ends (MOTIR-7025)
//   server → client  {"t":"signin","profile","state"}        sign-in state, on attach and on change
//   server → client  {"t":"exit","code","signal"}            the shell exited; the session is gone
//   server → client  {"t":"pong"}
//   server → client  {"t":"error","code"}                    session_limit | unknown_session | taken_over
//
// A session is a person's `shell` (`bash -l`) or a `run`: the one session a
// card's run lives in (`docs/decisions/agent-instance-run.md` §1), tagged with
// its run id. A `ready` with no `kind` is a shell, so a panel built before runs
// existed reads every frame it knew unchanged. A run session is WATCH-ONLY — input frames sent to it are dropped
// — and is listed so the panel can offer it beside the developer's own shell.
//
// Pure: no I/O, so the relay and the panel can read the same shapes.

/** The terminal path on the server. */
export const TERMINAL_PATH = '/v1/terminal';
/**
 * The chat path on the same server, behind the same relay token (MOTIR-7012 ·
 * `docs/decisions/agent-chat.md` Q4). Its frames are `chat/protocol.ts`'s.
 */
export const CHAT_PATH = '/v1/chat';

export type SignInState = 'signed_in' | 'signed_out' | 'unknown';

export type SessionKind = 'shell' | 'run';

/** One live session, as the panel lists it. `runId` only on a run session. */
export interface SessionListing {
  session: string;
  kind: SessionKind;
  runId?: string;
}

export type ErrorCode = 'session_limit' | 'unknown_session' | 'taken_over';

export type ClientFrame =
  | { t: 'open'; cols: number; rows: number; session?: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'ping'; active: boolean };

export type ServerFrame =
  | { t: 'ready'; session: string; resumed: boolean; kind?: 'run'; runId?: string }
  | { t: 'sessions'; sessions: SessionListing[] }
  | { t: 'signin'; profile: string | null; state: SignInState }
  | { t: 'exit'; code: number | null; signal: number | null }
  | { t: 'pong' }
  | { t: 'error'; code: ErrorCode };

/** The PTY dimension bounds a frame may ask for. */
const MAX_DIMENSION = 1000;

function dimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_DIMENSION) return null;
  return value;
}

/**
 * Parse one text frame. Returns null for anything that is not a well-formed
 * control frame — the caller ignores it rather than echoing any of it back.
 */
export function parseClientFrame(text: string): ClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  switch (frame['t']) {
    case 'open': {
      const cols = dimension(frame['cols']);
      const rows = dimension(frame['rows']);
      if (cols === null || rows === null) return null;
      const session = frame['session'];
      if (session !== undefined && session !== null && typeof session !== 'string') return null;
      return typeof session === 'string' && session.length > 0
        ? { t: 'open', cols, rows, session }
        : { t: 'open', cols, rows };
    }
    case 'resize': {
      const cols = dimension(frame['cols']);
      const rows = dimension(frame['rows']);
      if (cols === null || rows === null) return null;
      return { t: 'resize', cols, rows };
    }
    case 'ping':
      return { t: 'ping', active: frame['active'] === true };
    default:
      return null;
  }
}

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
