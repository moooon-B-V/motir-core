// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import {
  applyEvent,
  emptyTranscript,
  lineCount,
} from '@/app/(authed)/my-agents/_components/chat/transcriptModel';
import { TERMINAL_RECONNECT_WINDOW_MS } from '@/app/(authed)/my-agents/_components/useAgentTerminal';
import { CHAT_PING_MS } from '@/lib/agentChat/protocol';
import { CHAT_PING_INACTIVE, TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';

// THE CHAT TAB'S EDGES (Story MOTIR-6863 · MOTIR-7018 — the story gate's coverage
// floor over the tab). `AgentChat.test.tsx` (MOTIR-7017) draws each panel of the
// design; `agentChatTabGate.test.tsx` feeds the tab a real server's bytes. This
// file holds the paths neither reaches: every way the ticket fetch and the socket
// can fail, every close code the relay can send, the server frames that move no
// row (sign-in changes, pong, the silent refusals), a transcript long enough to
// window, and the transcript model's own corners.

// ── Sentry and xterm, at their module boundaries ────────────────────────────
const sentry = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@sentry/nextjs', () => {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      sentry.calls.push([name, ...args]);
    };
  return {
    addBreadcrumb: record('addBreadcrumb'),
    captureException: record('captureException'),
    captureMessage: record('captureMessage'),
    captureEvent: record('captureEvent'),
    setContext: record('setContext'),
    setExtra: record('setExtra'),
    withScope: record('withScope'),
  };
});
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    dispose() {}
    scrollToBottom() {}
    onData() {}
    onResize() {}
    onScroll() {}
    onWriteParsed() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

// ── the relay, at the WebSocket boundary ────────────────────────────────────
class FakeSocket {
  static instances: FakeSocket[] = [];
  static throwOnChat = false;
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    if (FakeSocket.throwOnChat && url.endsWith('/v1/chat')) throw new Error('blocked');
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get texts(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
  get frames(): Array<Record<string, unknown>> {
    return this.texts
      .filter((s) => s.startsWith('{"t":') && !s.startsWith('{"t":"ping"'))
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const chatSockets = () => FakeSocket.instances.filter((s) => s.url.endsWith('/v1/chat'));
const lastChat = () => chatSockets()[chatSockets().length - 1]!;

function agent(): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/moooon-b-v/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    region: 'iad',
    state: 'running',
    failureReason: null,
    terminalServer: 'present',
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 0,
    creditsThisMonth: 0,
    stopReason: null,
  };
}

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
const CHAT_TICKET = { url: 'wss://relay.motir.test/v1/chat', ticket: 'chat-t', expiresAt: 'x' };
const TERMINAL_TICKET = { url: 'wss://relay.motir.test/v1/terminal', ticket: 't', expiresAt: 'x' };

let chatTicket: () => Response | Promise<Response>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/terminal-ticket')) {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { channel?: string }) : {};
    return body.channel === 'chat' ? chatTicket() : json(200, TERMINAL_TICKET);
  }
  return json(200, { instances: [agent()], total: 1 });
});
const chatTicketCalls = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith('/terminal-ticket') &&
      (init as RequestInit | undefined)?.body === '{"channel":"chat"}',
  ).length;

const consoleCalls: unknown[][] = [];

beforeEach(() => {
  fetchMock.mockClear();
  FakeSocket.instances = [];
  FakeSocket.throwOnChat = false;
  sentry.calls.length = 0;
  consoleCalls.length = 0;
  chatTicket = () => json(200, CHAT_TICKET);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push([method, ...args]);
    });
  }
  window.history.replaceState(null, '', '/my-agents');
});
afterEach(() => {
  // No test here may print: an act() warning is a real finding.
  const printed = consoleCalls.map((c) => String(c[1]).slice(0, 200));
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(printed).toEqual([]);
  expect(sentry.calls).toEqual([]);
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

async function mount() {
  render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={{ instances: [agent()], total: 1 }}
      profiles={[{ id: 'claude', name: 'Claude Code' }]}
      maxPerUser={10}
      openAgentId="a1"
      openTab="chat"
    />,
  );
  await flush();
}

const panel = () => screen.getByTestId('agent-panel');
const connWord = () => screen.getByTestId('agent-conn').textContent;
const face = () => screen.queryByTestId('chat-face')?.textContent ?? '';

async function live(ws = lastChat(), hello: Record<string, unknown> = { signin: 'signed_in' }) {
  act(() => ws.accept());
  act(() => ws.frame({ t: 'hello', profile: 'claude', supported: true, ...hello }));
  act(() => ws.frame({ t: 'ready', session: null, resumed: false }));
  await flush();
  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the ticket and the dial, failing', () => {
  it('a ticket fetch that throws, a 500, and a grant with no url each retry — never a face of their own', async () => {
    vi.useFakeTimers();
    let calls = 0;
    chatTicket = () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      if (calls === 2) return json(500, { code: 'boom' });
      if (calls === 3)
        return {
          ok: false,
          status: 502,
          json: async () => Promise.reject(new Error('x')),
        } as unknown as Response;
      if (calls === 4) return json(200, { ticket: 'no-url' });
      if (calls === 5)
        return {
          ok: true,
          status: 200,
          json: async () => Promise.reject(new Error('x')),
        } as unknown as Response;
      return json(200, CHAT_TICKET);
    };
    await mount();
    expect(chatTicketCalls()).toBe(1);
    for (let i = 2; i <= 6; i += 1) {
      // The backoff doubles from one second: each step lands exactly one retry.
      await advance(1_000 * 2 ** (i - 2));
      expect(chatTicketCalls()).toBe(i);
    }
    // The sixth grant is good: a socket, and the chat goes live.
    await live();
    expect(connWord()).toContain('Live');
  });

  it('a WebSocket the browser refuses to construct retries too', async () => {
    vi.useFakeTimers();
    FakeSocket.throwOnChat = true;
    await mount();
    expect(chatSockets()).toHaveLength(0);
    FakeSocket.throwOnChat = false;
    await advance(30_000);
    expect(chatTicketCalls()).toBe(2);
    await live();
    expect(connWord()).toContain('Live');
  });

  it.each([
    [403, {}],
    [404, {}],
    [409, { code: 'not_running' }],
  ])('a %i ticket answer settles — nothing retries it', async (status, body) => {
    vi.useFakeTimers();
    chatTicket = () => json(status, body);
    await mount();
    await advance(TERMINAL_RECONNECT_WINDOW_MS + 30_000);
    expect(chatTicketCalls()).toBe(1);
    expect(chatSockets()).toHaveLength(0);
  });

  it('a ticket answer of no_terminal_server is the no-chat-server face', async () => {
    chatTicket = () => json(409, { code: 'no_terminal_server' });
    await mount();
    expect(connWord()).toContain('Unavailable');
    expect(face()).toContain('This agent can’t chat yet');
  });
});

describe('what the relay closes with', () => {
  it('4401 once is a stale ticket, fetched again; twice is lost', async () => {
    await mount();
    await live();
    act(() => lastChat().drop(TERMINAL_CLOSE.badTicket));
    await flush();
    expect(chatTicketCalls()).toBe(2);
    act(() => lastChat().drop(TERMINAL_CLOSE.badTicket));
    await flush();
    expect(connWord()).toContain('Disconnected');
    expect(within(panel()).getByRole('alert').textContent).toContain('Couldn’t reconnect.');
  });

  it('4410 — a server with no terminal at all — is the no-chat-server face', async () => {
    await mount();
    await live();
    act(() => lastChat().drop(TERMINAL_CLOSE.noTerminalServer));
    await flush();
    expect(face()).toContain('This agent can’t chat yet');
  });

  it.each([
    ['notOwner', TERMINAL_CLOSE.notOwner],
    ['notRunning', TERMINAL_CLOSE.notRunning],
  ])('%s settles: no reconnect', async (_name, code) => {
    vi.useFakeTimers();
    await mount();
    act(() => lastChat().accept());
    act(() => lastChat().drop(code));
    await advance(TERMINAL_RECONNECT_WINDOW_MS + 30_000);
    expect(chatTicketCalls()).toBe(1);
  });

  it('an unreachable machine through the whole window is lost with the machine’s words', async () => {
    vi.useFakeTimers();
    await mount();
    await live();
    chatTicket = () => json(502, {});
    act(() => lastChat().drop(TERMINAL_CLOSE.unreachable));
    await advance(TERMINAL_RECONNECT_WINDOW_MS + 30_000);
    expect(connWord()).toContain('Disconnected');
    expect(within(panel()).getByRole('alert').textContent).toContain(
      'The agent’s machine isn’t answering.',
    );
  });

  it('a close after the tab settled changes nothing', async () => {
    vi.useFakeTimers();
    await mount();
    act(() => lastChat().accept());
    act(() =>
      lastChat().frame({ t: 'hello', profile: 'claude', supported: false, signin: 'unknown' }),
    );
    act(() => lastChat().drop(1006));
    await advance(TERMINAL_RECONNECT_WINDOW_MS);
    expect(chatTicketCalls()).toBe(1);
    expect(face()).toContain('Chat isn’t available for');
  });
});

describe('a superseded connection is ignored', () => {
  it('the old socket’s open, message and close after a fresh ticket was fetched change nothing', async () => {
    await mount();
    const old = await live();
    act(() => old.drop(TERMINAL_CLOSE.badTicket));
    await flush();
    const fresh = lastChat();
    expect(fresh).not.toBe(old);
    act(() => old.onopen?.());
    act(() => old.frame({ t: 'error', code: 'taken_over' }));
    act(() => old.onclose?.({ code: TERMINAL_CLOSE.notOwner }));
    await flush();
    await live(fresh);
    expect(connWord()).toContain('Live');
    expect(chatTicketCalls()).toBe(2);
  });

  it('an open before the socket is ready sends no auth; a second open re-arms one heartbeat; a heartbeat on a closed socket sends nothing', async () => {
    vi.useFakeTimers();
    await mount();
    const ws = lastChat();
    act(() => ws.onopen?.());
    expect(ws.texts).toEqual([]);
    await live(ws);
    act(() => ws.onopen?.());
    ws.readyState = 3;
    await advance(CHAT_PING_MS);
    expect(ws.texts.filter((t) => t.startsWith('{"t":"ping"'))).toEqual([]);
  });

  it.each([
    ['a ticket that answers', () => json(200, CHAT_TICKET)],
    ['a refused ticket', () => json(500, {})],
    ['a fetch that fails', () => Promise.reject(new Error('offline'))],
  ] as const)('%s after the tab closed opens nothing', async (_name, answer) => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    chatTicket = async () => {
      await gate;
      return answer();
    };
    await mount();
    cleanup();
    await act(async () => {
      release();
      await gate;
    });
    await flush();
    expect(chatSockets()).toHaveLength(0);
  });

  it.each([
    ['refused', 500],
    ['granted', 200],
  ] as const)(
    'a %s ticket whose body arrives after the tab closed opens nothing',
    async (_name, status) => {
      let release!: () => void;
      const gate = new Promise<void>((ok) => (release = ok));
      chatTicket = () =>
        ({
          ok: status < 400,
          status,
          json: async () => {
            await gate;
            return CHAT_TICKET;
          },
        }) as Response;
      await mount();
      cleanup();
      await act(async () => {
        release();
        await gate;
      });
      await flush();
      expect(chatSockets()).toHaveLength(0);
    },
  );
});

describe('server frames that move no row', () => {
  it('an unsupported hello with no reason reads unsupported; no Open-Terminal-less face', async () => {
    await mount();
    act(() => lastChat().accept());
    act(() =>
      lastChat().frame({ t: 'hello', profile: 'claude', supported: false, signin: 'unknown' }),
    );
    await flush();
    expect(screen.getByTestId('chat-refusal').textContent).toContain('Chat isn’t available for');
    expect(
      within(screen.getByTestId('chat-face')).getByRole('button', { name: 'Open Terminal' }),
    ).toBeTruthy();
  });

  it('signin frames clear and keep the not-signed-in notice; pong and binary frames are ignored', async () => {
    await mount();
    const ws = await live(undefined, { signin: 'signed_out' });
    expect(within(panel()).getByRole('alert').textContent).toContain('isn’t signed in');
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_out' }));
    await flush();
    expect(within(panel()).getByRole('alert').textContent).toContain('isn’t signed in');
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_in' }));
    act(() => ws.frame({ t: 'pong' }));
    act(() => ws.onmessage?.({ data: new ArrayBuffer(4) }));
    act(() => ws.onmessage?.({ data: '{not a frame' }));
    await flush();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(connWord()).toContain('Live');
  });

  it('unknown_session opens a new chat; turn_running is a notice; no_turn is silent; taken_over ends the tab', async () => {
    await mount();
    const ws = await live();
    act(() => ws.frame({ t: 'error', code: 'unknown_session' }));
    await flush();
    expect(ws.frames.at(-1)).toEqual({ t: 'open' });
    act(() => ws.frame({ t: 'error', code: 'no_turn' }));
    await flush();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    act(() => ws.frame({ t: 'error', code: 'turn_running' }));
    await flush();
    expect(panel().textContent).toContain('A turn is already running on');
    act(() => ws.frame({ t: 'error', code: 'taken_over' }));
    await flush();
    expect(connWord()).toContain('Ended');
    expect(within(panel()).getByRole('button', { name: /here/i })).toBeTruthy();
  });

  it('an unsupported error mid-chat is the refusal face', async () => {
    await mount();
    const ws = await live();
    act(() => ws.frame({ t: 'error', code: 'unsupported' }));
    await flush();
    expect(screen.getByTestId('chat-refusal').textContent).toContain('Chat isn’t available for');
  });

  it('the heartbeat sends the inactive ping while the page is hidden', async () => {
    vi.useFakeTimers();
    await mount();
    const ws = await live();
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await advance(CHAT_PING_MS);
    expect(ws.texts).toContain(CHAT_PING_INACTIVE);
    hidden.mockRestore();
  });
});

describe('the session list and the prompt box', () => {
  it('New chat from the list sends a bare open, and keeps the not-signed-in notice; a session with an unreadable time lists without one', async () => {
    await mount();
    const ws = await live(undefined, { signin: 'signed_out' });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sessions' }));
    await flush();
    act(() =>
      ws.frame({
        t: 'sessions',
        items: [{ id: 's1', title: 'Undated session', updatedAt: 'not a date' }],
      }),
    );
    await flush();
    const row = screen.getByTestId('chat-session-row');
    expect(row.textContent).toBe('Undated session');
    const list = screen.getByText('Sessions on yue-claude').parentElement!;
    fireEvent.click(within(list).getByRole('button', { name: /New chat/ }));
    await flush();
    expect(ws.frames.at(-1)).toEqual({ t: 'open' });
    expect(within(panel()).getByRole('alert').textContent).toContain('isn’t signed in');
  });

  it('a prompt sent while not signed in keeps the notice; a refused prompt does not overwrite what was typed since', async () => {
    await mount();
    const ws = await live(undefined, { signin: 'signed_out' });
    const box = within(panel()).getByRole('textbox', { name: 'Prompt' });
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(ws.frames.at(-1)).toEqual({ t: 'prompt', text: 'first' });
    expect(within(panel()).getByRole('alert').textContent).toContain('isn’t signed in');
    fireEvent.change(box, { target: { value: 'typed since' } });
    act(() => ws.frame({ t: 'error', code: 'not_signed_in' }));
    await flush();
    expect((box as HTMLTextAreaElement).value).toBe('typed since');
  });

  it('a socket that stopped being open sends nothing: the prompt stays in the box, Stop is a no-op', async () => {
    await mount();
    const ws = await live();
    const box = within(panel()).getByRole('textbox', { name: 'Prompt' });
    act(() => ws.frame({ t: 'event', turn: 1, e: { k: 'user', text: 'running' } }));
    await flush();
    ws.readyState = 3;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    act(() => ws.frame({ t: 'event', turn: 1, e: { k: 'turn_end', reason: 'completed' } }));
    await flush();
    fireEvent.change(box, { target: { value: 'kept' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(ws.frames.filter((f) => f['t'] === 'prompt' || f['t'] === 'stop')).toEqual([]);
    expect((box as HTMLTextAreaElement).value).toBe('kept');
  });

  it('Enter on an empty box sends nothing', async () => {
    await mount();
    const ws = await live();
    const box = within(panel()).getByRole('textbox', { name: 'Prompt' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(ws.frames.filter((f) => f['t'] === 'prompt')).toHaveLength(0);
  });
});

describe('tool rows at their corners', () => {
  it('an other-kind call with no name, a command with no command, an edit with no diff, a read with no output', async () => {
    await mount();
    const ws = await live();
    const ev = (e: Record<string, unknown>) => act(() => ws.frame({ t: 'event', turn: 1, e }));
    ev({ k: 'user', text: 'go' });
    ev({ k: 'tool_call', id: 'o', kind: 'other', name: '', title: 'web_search' });
    ev({ k: 'tool_result', id: 'o', ok: true, truncated: false });
    ev({ k: 'tool_call', id: 'c', kind: 'command', name: 'Bash', title: 'list files' });
    ev({ k: 'tool_result', id: 'c', ok: true, truncated: false });
    ev({ k: 'tool_call', id: 'e', kind: 'edit', name: 'Edit', title: 'Edit a.md' });
    ev({ k: 'tool_result', id: 'e', ok: true, truncated: false });
    ev({
      k: 'tool_call',
      id: 'd',
      kind: 'edit',
      name: 'Edit',
      title: 'x',
      path: 'b.md',
      diff: '-\n+b\n x',
    });
    ev({ k: 'tool_result', id: 'd', ok: true, truncated: false });
    ev({ k: 'error', code: 'retry' });
    ev({ k: 'turn_end', reason: 'completed' });
    await flush();
    const rows = screen.getAllByTestId('chat-tool-row');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([
      'other',
      'command',
      'edit',
      'edit',
    ]);
    expect(rows[0]!.textContent).toContain('web_search');
    expect(rows[1]!.textContent).toContain('list files');
    fireEvent.click(within(rows[1]!).getByRole('button', { expanded: false }));
    expect(within(rows[1]!).getByTestId('chat-tool-body').textContent).toContain('No output.');
    fireEvent.click(within(rows[2]!).getByRole('button', { expanded: false }));
    expect(within(rows[2]!).getByTestId('chat-tool-body').textContent).toContain(
      'reported which file it changed, but not the change itself.',
    );
    fireEvent.click(within(rows[3]!).getByRole('button', { expanded: false }));
    const diff = within(rows[3]!).getByTestId('chat-tool-body');
    expect(within(diff).getByText('+b').className).toContain('--el-diff-added');
    // An error with no message says its code.
    expect(screen.getByTestId('chat-error').textContent).toContain('retry');
  });
});

describe('a long transcript', () => {
  it('windows once it overflows the viewport; scrolling up offers Jump to latest, which returns to the end', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(5_000);
    await mount();
    const ws = await live();
    for (let i = 0; i < 40; i += 1) {
      act(() => ws.frame({ t: 'event', turn: i + 1, e: { k: 'user', text: `prompt ${i}` } }));
      act(() => ws.frame({ t: 'event', turn: i + 1, e: { k: 'turn_end', reason: 'completed' } }));
    }
    await flush();
    const transcript = screen.getByTestId('chat-transcript');
    // Windowed: not every row is mounted.
    expect(screen.getAllByTestId('chat-user').length).toBeLessThan(40);
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    await flush();
    const jump = within(panel()).getByRole('button', { name: 'Jump to latest' });
    fireEvent.click(jump);
    await flush();
    expect(within(panel()).queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    expect(transcript.scrollTop).toBe(5_000);
    height.mockRestore();
    scrollHeight.mockRestore();
  });
});

describe('the transcript model', () => {
  it('a re-announced call replaces its row; a result with no call is kept as an other row; an error keeps no absent message', () => {
    let t = emptyTranscript();
    t = applyEvent(t, 1, { k: 'tool_call', id: 'c', kind: 'command', name: 'Bash', title: 'a' });
    t = applyEvent(t, 1, {
      k: 'tool_call',
      id: 'c',
      kind: 'command',
      name: 'Bash',
      title: 'a',
      command: 'ls',
    });
    expect(t.rows).toHaveLength(1);
    t = applyEvent(t, 1, { k: 'tool_result', id: 'lost', ok: true, output: 'x', truncated: false });
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]).toMatchObject({ type: 'tool', call: { kind: 'other' } });
    t = applyEvent(t, 1, { k: 'error', code: 'retry' });
    expect(t.rows[2]).toEqual({ type: 'error', key: expect.any(String), code: 'retry' });
    expect(lineCount('')).toBe(0);
    expect(lineCount('a\nb\n')).toBe(2);
  });
});
