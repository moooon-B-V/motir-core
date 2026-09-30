import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_PING_ACTIVE,
  CHAT_PING_INACTIVE,
  CHAT_PING_MS,
  MAX_LISTED_SESSIONS,
  MAX_PROMPT_BYTES,
  encodeChatClientFrame,
  parseChatServerFrame,
  promptBytes,
  type ChatClientFrame,
  type ChatErrorCode,
  type ChatRefusal,
  type ChatServerFrame,
  type ChatSessionSummary,
  type ChatSignInState,
} from '@/lib/agentChat/protocol';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { applyEvent, emptyTranscript, type Transcript } from './chat/transcriptModel';
import { TERMINAL_RECONNECT_WINDOW_MS, TERMINAL_RETRY_CAP_MS } from './useAgentTerminal';

// THE AGENT CHAT'S SOCKET (Story MOTIR-6863 · MOTIR-7017) — the client side of
// `docs/decisions/agent-chat.md` Q4–Q9, built in the terminal hook's shape
// (`useAgentTerminal.ts`) and not forked from it in spirit: ONE state machine,
// wake-then-ticket, reconnect with backoff over the same minute, the same close
// codes, plus the chat's own.
//
//   ticket  POST …/instances/:id/terminal-ticket  { "channel": "chat" }
//   socket  wss `url`; first frame {"t":"auth","ticket"}; the server says `hello`
//           (Q1/Q2's verdict and the sign-in state); a supported agent is then
//           sent `open` — a new chat, or the session this tab holds
//   close   4401 stale ticket (one silent retry) · 4403 not yours · 4409 not running
//           · 4410/4411 no chat server (no reconnect) · else the reconnect loop
//   beat    the relay's own heartbeat BYTES every 20 s (Q9): active while the
//           browser tab is visible, inactive when it is hidden
//
// ⚠️ NOTHING OF THE CONVERSATION LEAVES THIS MODULE BUT TO THE PAGE (Q10). The
// transcript, the prompts and the session list live in component state only:
// no browser storage, no Sentry breadcrumb or event, no analytics, no console.

/** Every state the Chat tab's connection can be in. */
export type ChatConn =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'reconnecting' }
  | { kind: 'lost'; machine: boolean }
  | { kind: 'takenOver' }
  | { kind: 'refused'; reason: ChatRefusal }
  | { kind: 'noChatServer' }
  | { kind: 'notAvailable' }
  | { kind: 'notRunning' };

/** A refusal strip above the prompt box (design panel 5 and 7). */
export type ChatNotice = 'turnRunning' | 'tooLarge' | 'notSignedIn';

/**
 * Q4's refusal codes → what the tab does with them. `notice` is a strip above the
 * box (`myAgents.panel.chat.notice.*`); `refused` is a whole-tab face; `conn`
 * moves the connection; `silent` has no words (as on the terminal: a `no_turn`
 * after a turn already ended, an `unknown_session` reopened fresh, a `bad_frame`).
 */
export const CHAT_REFUSAL_WORDS: Readonly<
  Record<
    ChatErrorCode,
    | { kind: 'notice'; notice: ChatNotice; key: string }
    | { kind: 'refused'; key: string }
    | { kind: 'conn'; key: string }
    | { kind: 'silent' }
  >
> = {
  unsupported: { kind: 'refused', key: 'chat.unsupported' },
  subscription_signin: { kind: 'refused', key: 'chat.subscription.body' },
  not_signed_in: { kind: 'notice', notice: 'notSignedIn', key: 'chat.notice.notSignedIn' },
  turn_running: { kind: 'notice', notice: 'turnRunning', key: 'chat.notice.turnRunning' },
  too_large: { kind: 'notice', notice: 'tooLarge', key: 'chat.notice.tooLarge' },
  taken_over: { kind: 'conn', key: 'chat.notice.takenOver' },
  no_turn: { kind: 'silent' },
  unknown_session: { kind: 'silent' },
  bad_frame: { kind: 'silent' },
};

/** The session this tab holds, and how it came to be open. */
export interface ChatSessionView {
  id: string | null;
  /** The list's title for a session the reader chose; null for a new chat. */
  title: string | null;
  /** The reader opened it from the session list (the bar's Resumed chip). */
  resumed: boolean;
}

/** A state the socket stays in until the reader acts: its close is not a drop. */
const SETTLED: ReadonlySet<ChatConn['kind']> = new Set([
  'takenOver',
  'refused',
  'noChatServer',
  'notAvailable',
  'notRunning',
  'lost',
]);

export function useAgentChat({
  projectKey,
  agentId,
  enabled,
}: {
  projectKey: string;
  agentId: string;
  /** The agent reads `running`, serves a terminal, its profile can chat, and the tab was opened. */
  enabled: boolean;
}) {
  const [conn, setConnState] = useState<ChatConn>({ kind: 'idle' });
  const [signIn, setSignIn] = useState<ChatSignInState | null>(null);
  const [everLive, setEverLive] = useState(false);
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [session, setSession] = useState<ChatSessionView>({
    id: null,
    title: null,
    resumed: false,
  });
  const [historyNote, setHistoryNote] = useState<'truncated' | 'unavailable' | null>(null);
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const [draft, setDraft] = useState('');
  /** The prompt sent and not yet echoed back as the turn's `user` event. */
  const [pending, setPending] = useState<string | null>(null);

  const connRef = useRef<ChatConn>(conn);
  const sessionRef = useRef<ChatSessionView>(session);
  const pendingRef = useRef<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const epoch = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const windowStart = useRef<number | null>(null);
  const attempt = useRef(0);
  const staleRetried = useRef(false);
  const lastCloseCode = useRef<number | null>(null);
  const wasLive = useRef(false);
  const ticketUrl = `/api/projects/${encodeURIComponent(projectKey)}/instances/${encodeURIComponent(
    agentId,
  )}/terminal-ticket`;

  const setConn = useCallback((next: ChatConn) => {
    connRef.current = next;
    setConnState(next);
  }, []);

  const setSessionView = useCallback((next: ChatSessionView) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const setPendingPrompt = useCallback((next: string | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const teardown = useCallback(() => {
    epoch.current += 1;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);
    retryTimer.current = null;
    pingTimer.current = null;
    const socket = ws.current;
    ws.current = null;
    if (socket && socket.readyState <= 1) {
      try {
        socket.close(1000);
      } catch {
        // already closing
      }
    }
  }, []);

  const connectRef = useRef<() => void>(() => {});

  const scheduleRetry = useCallback(() => {
    const now = Date.now();
    if (windowStart.current === null) windowStart.current = now;
    if (now - windowStart.current >= TERMINAL_RECONNECT_WINDOW_MS) {
      setConn({ kind: 'lost', machine: lastCloseCode.current === TERMINAL_CLOSE.unreachable });
      return;
    }
    setConn(wasLive.current ? { kind: 'reconnecting' } : { kind: 'connecting' });
    const delay = Math.min(1_000 * 2 ** attempt.current, TERMINAL_RETRY_CAP_MS);
    attempt.current += 1;
    retryTimer.current = setTimeout(() => connectRef.current(), delay);
  }, [setConn]);

  const sendFrame = (socket: WebSocket | null, frame: ChatClientFrame): boolean => {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(encodeChatClientFrame(frame));
    return true;
  };

  /** Attach: the session this tab holds, or a new chat. */
  const openFrame = (): ChatClientFrame => {
    const id = sessionRef.current.id;
    return id ? { t: 'open', session: id } : { t: 'open' };
  };

  /** A refused prompt goes back into the box (design panel 5: a refusal never empties it). */
  const returnPrompt = useCallback(() => {
    const text = pendingRef.current;
    if (text === null) return;
    setPendingPrompt(null);
    setDraft((current) => (current.length === 0 ? text : current));
  }, [setPendingPrompt]);

  const onFrame = useCallback(
    (socket: WebSocket, frame: ChatServerFrame) => {
      switch (frame.t) {
        case 'hello':
          setSignIn(frame.signin);
          if (!frame.supported) {
            // Q1/Q2: the server's verdict — no `open`, no prompt box.
            setConn({ kind: 'refused', reason: frame.reason ?? 'unsupported' });
            return;
          }
          sendFrame(socket, openFrame());
          return;
        case 'ready': {
          const current = sessionRef.current;
          if (frame.session !== null && frame.session !== current.id) {
            setSessionView({ ...current, id: frame.session });
          }
          if (!frame.resumed) {
            // A new chat: an empty transcript until the first turn.
            setTranscript(emptyTranscript());
            setHistoryNote(null);
          }
          windowStart.current = null;
          attempt.current = 0;
          staleRetried.current = false;
          lastCloseCode.current = null;
          wasLive.current = true;
          setEverLive(true);
          setConn({ kind: 'live' });
          return;
        }
        case 'history': {
          // A resume (or a reconnect to this session): the earlier turns, drawn
          // exactly as live ones; the running turn's kept events follow as `event`.
          let next = emptyTranscript();
          for (const e of frame.events) next = applyEvent(next, 'history', e);
          setTranscript(next);
          setHistoryNote(
            frame.truncated ? (frame.events.length === 0 ? 'unavailable' : 'truncated') : null,
          );
          return;
        }
        case 'session':
          setSessionView({ ...sessionRef.current, id: frame.id });
          return;
        case 'event':
          if (frame.e.k === 'user' && pendingRef.current !== null) setPendingPrompt(null);
          setTranscript((t) => applyEvent(t, frame.turn, frame.e));
          return;
        case 'sessions': {
          const items = [...frame.items]
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, MAX_LISTED_SESSIONS);
          setSessions(items);
          return;
        }
        case 'signin':
          setSignIn(frame.state);
          if (frame.state !== 'signed_out') setNotice((n) => (n === 'notSignedIn' ? null : n));
          return;
        case 'pong':
          return;
        case 'error': {
          const words = CHAT_REFUSAL_WORDS[frame.code];
          if (frame.code === 'unknown_session') {
            // The session is gone from the CLI's store: a new chat, with no words.
            setSessionView({ id: null, title: null, resumed: false });
            sendFrame(socket, { t: 'open' });
            return;
          }
          if (frame.code === 'taken_over') {
            setConn({ kind: 'takenOver' });
            return;
          }
          if (words.kind === 'refused') {
            returnPrompt();
            setConn({ kind: 'refused', reason: frame.code as ChatRefusal });
            return;
          }
          if (words.kind === 'notice') {
            returnPrompt();
            setNotice(words.notice);
          }
          return;
        }
      }
    },
    [returnPrompt, setConn, setPendingPrompt, setSessionView],
  );

  const onClosed = useCallback(
    (code: number) => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = null;
      ws.current = null;
      // A prompt that never reached a turn is the reader's again.
      returnPrompt();
      if (SETTLED.has(connRef.current.kind)) return;
      switch (code) {
        case TERMINAL_CLOSE.badTicket:
          if (!staleRetried.current) {
            staleRetried.current = true;
            connectRef.current();
          } else {
            setConn({ kind: 'lost', machine: false });
          }
          return;
        case TERMINAL_CLOSE.notOwner:
          setConn({ kind: 'notAvailable' });
          return;
        case TERMINAL_CLOSE.notRunning:
          setConn({ kind: 'notRunning' });
          return;
        case TERMINAL_CLOSE.noTerminalServer:
        case TERMINAL_CLOSE.noChatServer:
          // Q8: the image predates the chat. The dial is the probe; nothing retries it.
          setConn({ kind: 'noChatServer' });
          return;
        default:
          lastCloseCode.current = code;
          scheduleRetry();
      }
    },
    [returnPrompt, scheduleRetry, setConn],
  );

  const connect = useCallback(async () => {
    teardown();
    const mine = epoch.current;
    let res: Response;
    try {
      res = await fetch(ticketUrl, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'chat' }),
      });
    } catch {
      if (mine === epoch.current) scheduleRetry();
      return;
    }
    if (mine !== epoch.current) return;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      if (mine !== epoch.current) return;
      if (res.status === 403 || res.status === 404) setConn({ kind: 'notAvailable' });
      else if (body?.code === 'no_terminal_server') setConn({ kind: 'noChatServer' });
      else if (body?.code === 'not_running') setConn({ kind: 'notRunning' });
      else scheduleRetry();
      return;
    }
    const grant = (await res.json().catch(() => null)) as { url?: string; ticket?: string } | null;
    if (mine !== epoch.current) return;
    if (!grant?.url || !grant.ticket) {
      scheduleRetry();
      return;
    }
    const ticket = grant.ticket;
    let socket: WebSocket;
    try {
      socket = new WebSocket(grant.url);
    } catch {
      scheduleRetry();
      return;
    }
    ws.current = socket;
    socket.onopen = () => {
      if (mine !== epoch.current) return;
      // The ticket rides the first frame, never the URL (terminal Q3).
      if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'auth', ticket }));
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (socket.readyState !== 1) return;
        const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
        // Q9: the relay compares these exact bytes; they are never re-serialised.
        socket.send(visible ? CHAT_PING_ACTIVE : CHAT_PING_INACTIVE);
      }, CHAT_PING_MS);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (mine !== epoch.current) return;
      if (typeof event.data !== 'string') return; // Q4: no binary frames on the chat.
      const frame = parseChatServerFrame(event.data);
      if (frame) onFrame(socket, frame);
    };
    socket.onclose = (event: CloseEvent) => {
      if (mine !== epoch.current) return;
      onClosed(event.code);
    };
  }, [onClosed, onFrame, scheduleRetry, setConn, teardown, ticketUrl]);

  useEffect(() => {
    connectRef.current = () => void connect();
  }, [connect]);

  /** Start over from the reader's click: a fresh window, a fresh ticket, the same session. */
  const restart = useCallback(() => {
    windowStart.current = null;
    attempt.current = 0;
    staleRetried.current = false;
    lastCloseCode.current = null;
    setConn(wasLive.current ? { kind: 'reconnecting' } : { kind: 'connecting' });
    void connect();
  }, [connect, setConn]);

  const stopAll = useCallback(() => {
    teardown();
    wasLive.current = false;
    setConn({ kind: 'idle' });
  }, [setConn, teardown]);

  useEffect(() => {
    if (!enabled) {
      // Synchronising with the socket (an external system): the agent stopped
      // being reachable, or the tab was never opened.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      stopAll();
      return;
    }
    wasLive.current = false;
    restart();
    return teardown;
    // `enabled` flipping is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, agentId]);

  // Closing the panel closes the socket.
  useEffect(() => teardown, [teardown]);

  /** Send the draft as a prompt. False when it was refused before the wire. */
  const send = useCallback((): boolean => {
    const text = draft;
    if (text.trim().length === 0) return false;
    if (connRef.current.kind !== 'live' || pendingRef.current !== null) return false;
    if (promptBytes(text) > MAX_PROMPT_BYTES) {
      // Q4's bound, said before the round trip; the text stays in the box.
      setNotice('tooLarge');
      return false;
    }
    if (!sendFrame(ws.current, { t: 'prompt', text })) return false;
    setNotice((n) => (n === 'notSignedIn' ? n : null));
    setPendingPrompt(text);
    setDraft('');
    return true;
  }, [draft, setPendingPrompt]);

  const stop = useCallback(() => {
    sendFrame(ws.current, { t: 'stop' });
  }, []);

  const listSessions = useCallback(() => {
    sendFrame(ws.current, { t: 'list' });
  }, []);

  /** Open a session from the list, or a new chat (`null`). */
  const openSession = useCallback(
    (summary: ChatSessionSummary | null) => {
      if (connRef.current.kind !== 'live') return;
      const next: ChatSessionView = summary
        ? { id: summary.id, title: summary.title, resumed: true }
        : { id: null, title: null, resumed: false };
      setSessionView(next);
      setTranscript(emptyTranscript());
      setHistoryNote(null);
      setNotice((n) => (n === 'notSignedIn' ? n : null));
      sendFrame(ws.current, summary ? { t: 'open', session: summary.id } : { t: 'open' });
    },
    [setSessionView],
  );

  return {
    conn,
    signIn,
    everLive,
    transcript,
    session,
    historyNote,
    sessions,
    notice,
    draft,
    setDraft,
    pending,
    send,
    stop,
    listSessions,
    openSession,
    /** Lost / 4502 / taken over: the same session, a new ticket. */
    reconnect: restart,
  };
}
