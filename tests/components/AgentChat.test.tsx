// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import { CHAT_REFUSAL_WORDS } from '@/app/(authed)/my-agents/_components/useAgentChat';
import { TERMINAL_RECONNECT_WINDOW_MS } from '@/app/(authed)/my-agents/_components/useAgentTerminal';
import { CHAT_ERROR_CODES, CHAT_PING_MS } from '@/lib/agentChat/protocol';
import { CHAT_PING_ACTIVE, CHAT_PING_INACTIVE, TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { CHAT_PROFILES } from '@/lib/agentInstances/profiles';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';

// THE CHAT TAB (Story MOTIR-6863 · MOTIR-7017), held to the approved delta
// `design/my-agents/my-agents--chat.mock.html` (MOTIR-7011) and
// `docs/decisions/agent-chat.md` Q1–Q10. The routes are stubbed at `fetch`, the
// relay at `WebSocket` (one fake per socket, the terminal's and the chat's told
// apart by their URL), xterm at its module. What is asserted is the tab's own
// decisions: which ticket it asks for, the exact frames and heartbeat bytes it
// sends, the rows it draws for each transcript event, and every state in which
// the agent cannot chat.

// ── Sentry, at the module boundary: the Q10 guard reads what reached it ──────
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

// ── xterm, at the module boundary (happy-dom has no canvas) ─────────────────
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

// ── the relay, at the WebSocket boundary ───────────────────────────────────
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
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
    return this.texts.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const chatSockets = () => FakeSocket.instances.filter((s) => s.url.endsWith('/v1/chat'));
const terminalSockets = () => FakeSocket.instances.filter((s) => s.url.endsWith('/v1/terminal'));
const lastChat = () => chatSockets()[chatSockets().length - 1]!;

// ── fixtures ───────────────────────────────────────────────────────────────
const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'aider', name: 'Aider' },
];

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
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
    machineSecondsThisMonth: 72 * 60,
    creditsThisMonth: 72,
    stopReason: null,
    activeRun: null,
    lastRun: null,
    scheduledDeletionAt: null,
    ...over,
  };
}
const aider = (over: Partial<AgentInstanceListItemDto> = {}) =>
  agent({ id: 'a3', name: 'yue-aider', profileId: 'aider', profileName: 'Aider', ...over });
const codex = (over: Partial<AgentInstanceListItemDto> = {}) =>
  agent({ id: 'a2', name: 'yue-codex', profileId: 'codex', profileName: 'Codex', ...over });

const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
  planLapse: null,
});

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const TERMINAL_TICKET = {
  url: 'wss://relay.motir.test/v1/terminal',
  ticket: 'term-t',
  expiresAt: 'x',
};
const CHAT_TICKET = { url: 'wss://relay.motir.test/v1/chat', ticket: 'chat-t', expiresAt: 'x' };

let routes: {
  list: () => AgentInstanceListPageDto;
  chatTicket: () => Response;
  wake: () => Response;
};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/terminal-ticket')) {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { channel?: string }) : {};
    return body.channel === 'chat' ? routes.chatTicket() : json(200, TERMINAL_TICKET);
  }
  if (url.endsWith('/wake')) return routes.wake();
  return json(200, routes.list());
});
const ticketBodies = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/terminal-ticket'))
    .map(([, init]) => (init as RequestInit | undefined)?.body ?? null);
const chatTicketCalls = () => ticketBodies().filter((b) => b === '{"channel":"chat"}').length;
const terminalTicketCalls = () => ticketBodies().filter((b) => b === null).length;

const consoleCalls: unknown[][] = [];

beforeEach(() => {
  fetchMock.mockClear();
  FakeSocket.instances = [];
  sentry.calls.length = 0;
  consoleCalls.length = 0;
  routes = {
    list: () => page([agent(), codex({ state: 'hibernated' }), aider()]),
    chatTicket: () => json(200, CHAT_TICKET),
    wake: () => json(202, {}),
  };
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push([method, ...args]);
    });
  }
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/my-agents');
});
afterEach(() => {
  // No test here may print: an act() warning is a real finding (CLAUDE.md), and a
  // console line is a sink the conversation must never reach (Q10).
  const printed = consoleCalls.map((c) => String(c[1]).slice(0, 200));
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(printed).toEqual([]);
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  opts: {
    openAgentId?: string;
    openTab?: 'terminal' | 'chat';
    messages?: Record<string, unknown>;
    initial?: AgentInstanceListPageDto;
  } = {},
) {
  const result = render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={opts.initial ?? routes.list()}
      profiles={PROFILES}
      maxPerUser={10}
      openAgentId={opts.openAgentId ?? 'a1'}
      openTab={opts.openTab ?? 'terminal'}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
  await flush();
  return result;
}

const panel = () => screen.getByTestId('agent-panel');
const connWord = () => screen.getByTestId('agent-conn').textContent;
const tabs = () => within(within(panel()).getByRole('navigation', { name: 'Agent views' }));

async function openChat() {
  fireEvent.click(tabs().getByRole('button', { name: 'Chat' }));
  await flush();
}

/** Accept the chat socket, say hello, and attach a new chat. */
async function chatLive(
  hello: Record<string, unknown> = { supported: true, signin: 'signed_in' },
  ready: Record<string, unknown> = { session: null, resumed: false },
) {
  const ws = lastChat();
  act(() => ws.accept());
  act(() => ws.frame({ t: 'hello', profile: 'claude', ...hello }));
  act(() => ws.frame({ t: 'ready', ...ready }));
  await flush();
  return ws;
}

const ev = (ws: FakeSocket, turn: number, e: Record<string, unknown>) =>
  act(() => ws.frame({ t: 'event', turn, e }));

const promptBox = () => within(panel()).getByRole('textbox', { name: 'Prompt' });
function type(text: string) {
  fireEvent.change(promptBox(), { target: { value: text } });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the tab in the track (panel 1)', () => {
  it('Chat sits beside Terminal; selecting it asks for a chat ticket, connects, and shows an empty new chat', async () => {
    await mount();
    const names = tabs()
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['Terminal', 'Chat']);
    expect(chatTicketCalls()).toBe(0);
    expect(chatSockets()).toHaveLength(0);

    await openChat();
    expect(window.location.search).toContain('tab=chat');
    expect(tabs().getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
    expect(chatTicketCalls()).toBe(1);
    const ws = lastChat();
    expect(ws.url).toBe(CHAT_TICKET.url);
    expect(ws.url).not.toContain(CHAT_TICKET.ticket);
    expect(panel().textContent).toContain('Connecting to yue-claude’s chat…');

    act(() => ws.accept());
    expect(ws.frames[0]).toEqual({ t: 'auth', ticket: 'chat-t' });
    act(() => ws.frame({ t: 'hello', profile: 'claude', supported: true, signin: 'signed_in' }));
    expect(ws.frames[1]).toEqual({ t: 'open' });
    act(() => ws.frame({ t: 'ready', session: null, resumed: false }));
    await flush();

    expect(connWord()).toContain('Live');
    expect(screen.getByTestId('chat-title').textContent).toBe('New chat');
    const empty = screen.getByTestId('chat-empty');
    expect(empty.textContent).toContain('Start a chat with Claude Code');
    expect(empty.textContent).toContain(
      'It works in ~/workspace on yue-claude, with the same files and sign-in as the terminal.',
    );
    expect(within(empty).getByText('~/workspace').tagName).toBe('CODE');
    // Send is off on an empty box.
    expect(
      (within(panel()).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('an agent still opens on Terminal; the address’s &tab=chat reopens the chat', async () => {
    await mount({ openTab: 'chat' });
    expect(tabs().getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
    expect(chatTicketCalls()).toBe(1);
    // Back to Terminal drops the parameter.
    fireEvent.click(tabs().getByRole('button', { name: 'Terminal' }));
    await flush();
    expect(window.location.search).not.toContain('tab=');
    expect(tabs().getByRole('button', { name: 'Terminal' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('the transcript (panels 2–4)', () => {
  it('a prompt renders the user row, streams text, draws one collapsed row per tool call, and a turn end', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();

    type('List the files');
    const send = within(panel()).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await flush();
    expect(ws.frames).toContainEqual({ t: 'prompt', text: 'List the files' });
    // Sending: the box is emptied, the prompt is already in the transcript.
    expect((promptBox() as HTMLTextAreaElement).value).toBe('');
    expect(within(panel()).getByRole('button', { name: /Sending…/ })).toBeTruthy();
    expect(screen.getAllByTestId('chat-user').map((r) => r.textContent)).toEqual([
      'List the files',
    ]);

    ev(ws, 1, { k: 'user', text: 'List the files' });
    ev(ws, 1, { k: 'text', id: 'm1', delta: 'Let me ' });
    ev(ws, 1, { k: 'text', id: 'm1', delta: 'look.' });
    await flush();
    expect(screen.getAllByTestId('chat-user')).toHaveLength(1);
    expect(screen.getAllByTestId('chat-text')).toHaveLength(1);
    expect(screen.getByTestId('chat-text').textContent).toContain('Let me look.');
    expect(screen.getByTestId('chat-caret')).toBeTruthy();
    expect(screen.getByTestId('chat-working').textContent).toBe('Claude Code is working…');

    ev(ws, 1, {
      k: 'tool_call',
      id: 'c1',
      kind: 'command',
      name: 'Bash',
      title: 'ls',
      command: 'ls',
    });
    await flush();
    let rows = screen.getAllByTestId('chat-tool-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-kind')).toBe('command');
    expect(rows[0]!.textContent).toContain('Ran');
    expect(rows[0]!.textContent).toContain('Running…');
    ev(ws, 1, {
      k: 'tool_result',
      id: 'c1',
      ok: true,
      output: 'a.txt\nb.md\n',
      exitCode: 0,
      truncated: false,
    });
    ev(ws, 1, {
      k: 'tool_call',
      id: 'c2',
      kind: 'edit',
      name: 'Edit',
      title: 'Edit notes.md',
      path: 'notes.md',
      diff: '--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old line\n+new line',
    });
    ev(ws, 1, { k: 'tool_result', id: 'c2', ok: true, truncated: false });
    ev(ws, 1, {
      k: 'tool_call',
      id: 'c3',
      kind: 'read',
      name: 'Read',
      title: 'Read a.txt',
      path: 'a.txt',
    });
    ev(ws, 1, {
      k: 'tool_result',
      id: 'c3',
      ok: false,
      output: 'no such file',
      exitCode: 1,
      truncated: false,
    });
    ev(ws, 1, { k: 'error', code: 'retry', message: 'rate limited, retrying' });
    ev(ws, 1, { k: 'other', name: 'compact_boundary' });
    ev(ws, 1, { k: 'text', id: 'm2', delta: 'The directory has **two** files.' });
    await flush();

    rows = screen.getAllByTestId('chat-tool-row');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['command', 'edit', 'read']);
    // Collapsed by default — a failure too.
    expect(screen.queryAllByTestId('chat-tool-body')).toHaveLength(0);
    expect(rows[0]!.textContent).toContain('exit 0');
    expect(rows[1]!.textContent).toContain('+1 −1');
    expect(rows[2]!.getAttribute('data-failed')).toBe('true');
    expect(rows[2]!.textContent).toContain('Failed · exit 1');

    // Expand: the command's output, then the edit's diff — as text.
    fireEvent.click(within(rows[0]!).getByRole('button', { expanded: false }));
    expect(within(rows[0]!).getByTestId('chat-tool-body').textContent).toContain('a.txt\nb.md');
    fireEvent.click(within(rows[1]!).getByRole('button', { expanded: false }));
    const diff = within(rows[1]!).getByTestId('chat-tool-body');
    expect(within(diff).getByText('+new line').className).toContain('--el-diff-added');
    expect(within(diff).getByText('-old line').className).toContain('--el-diff-removed');

    expect(screen.getByTestId('chat-error').textContent).toBe(
      'Claude Code reported a problem and kept going: rate limited, retrying',
    );
    expect(screen.getByTestId('chat-other').textContent).toBe('Unshown event: compact_boundary');
    // Assistant text is Markdown, sanitised: the bold is an element, not asterisks.
    expect(screen.getAllByTestId('chat-text')[1]!.querySelector('strong')?.textContent).toBe('two');

    ev(ws, 1, { k: 'turn_end', reason: 'completed' });
    await flush();
    const end = screen.getByTestId('chat-turn-end');
    expect(end.getAttribute('data-reason')).toBe('completed');
    expect(within(end).getByRole('separator').textContent).toBe('Turn complete');
    expect(screen.queryByTestId('chat-caret')).toBeNull();
    expect(screen.queryByTestId('chat-working')).toBeNull();
    expect(screen.getByTestId('chat-title').textContent).toBe('List the files');
  });

  it('a failed turn says its code in words; the Q2 backstop has its own sentence', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    ev(ws, 1, { k: 'user', text: 'go' });
    ev(ws, 1, { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' });
    ev(ws, 2, { k: 'user', text: 'again' });
    ev(ws, 2, { k: 'turn_end', reason: 'failed', code: 'subscription_signin' });
    await flush();
    const ends = screen.getAllByTestId('chat-turn-end');
    expect(ends[0]!.textContent).toContain('Turn failed');
    expect(ends[0]!.textContent).toContain('Claude Code stopped unexpectedly (exit_nonzero).');
    expect(ends[1]!.textContent).toContain(
      'Claude Code is signed in with a Claude subscription, which the chat can’t use.',
    );
  });

  it('Enter sends, Shift+Enter does not', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    type('one');
    fireEvent.keyDown(promptBox(), { key: 'Enter', shiftKey: true });
    expect(ws.frames.filter((f) => f['t'] === 'prompt')).toHaveLength(0);
    fireEvent.keyDown(promptBox(), { key: 'Enter' });
    await flush();
    expect(ws.frames).toContainEqual({ t: 'prompt', text: 'one' });
  });
});

describe('Stop (panel 5, Q6)', () => {
  it('while a turn runs Send becomes Stop; Stop sends the stop frame; a stopped turn_end draws the stopped marker', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    type('build it');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    ev(ws, 3, { k: 'user', text: 'build it' });
    ev(ws, 3, { k: 'text', id: 'x', delta: 'Building' });
    await flush();
    expect(within(panel()).queryByRole('button', { name: 'Send' })).toBeNull();
    // The box stays editable while the turn runs.
    expect((promptBox() as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    expect(ws.frames[ws.frames.length - 1]).toEqual({ t: 'stop' });
    ev(ws, 3, { k: 'turn_end', reason: 'stopped' });
    await flush();
    const end = screen.getByTestId('chat-turn-end');
    expect(end.getAttribute('data-reason')).toBe('stopped');
    expect(end.textContent).toContain('Stopped');
    expect(end.textContent).toContain(
      'You stopped this turn. The reply above is as far as it got.',
    );
    // The streamed text stays.
    expect(screen.getByTestId('chat-text').textContent).toContain('Building');
    expect(within(panel()).getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('the session list and resume (panel 6, Q7)', () => {
  it('lists newest first; choosing one sends open with the session and draws its history', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sessions' }));
    await flush();
    expect(ws.frames[ws.frames.length - 1]).toEqual({ t: 'list' });
    act(() =>
      ws.frame({
        t: 'sessions',
        items: [
          { id: 'old', title: 'Older session', updatedAt: '2026-09-28T10:00:00.000Z' },
          {
            id: 'new',
            title: 'Tidy the docker compose file',
            updatedAt: '2026-09-30T09:00:00.000Z',
          },
          { id: 'mid', title: 'Middle session', updatedAt: '2026-09-29T10:00:00.000Z' },
        ],
      }),
    );
    await flush();
    const rows = screen.getAllByTestId('chat-session-row');
    expect(rows.map((r) => r.textContent?.split(/\d|yesterday|ago|last/)[0])).toEqual([
      'Tidy the docker compose file',
      'Middle session',
      'Older session',
    ]);
    expect(screen.getByText('Sessions on yue-claude')).toBeTruthy();
    fireEvent.click(rows[0]!);
    await flush();
    expect(ws.frames[ws.frames.length - 1]).toEqual({ t: 'open', session: 'new' });

    act(() => ws.frame({ t: 'ready', session: 'new', resumed: true }));
    act(() =>
      ws.frame({
        t: 'history',
        events: [
          { k: 'user', text: 'Tidy the docker compose file' },
          { k: 'text', id: 'a', delta: 'Done tidying.' },
          { k: 'turn_end', reason: 'completed' },
        ],
        truncated: false,
      }),
    );
    await flush();
    expect(screen.getByTestId('chat-title').textContent).toBe('Tidy the docker compose file');
    expect(within(panel()).getByText('Resumed')).toBeTruthy();
    expect(screen.getAllByTestId('chat-user')[0]!.textContent).toBe('Tidy the docker compose file');
    expect(screen.getByTestId('chat-text').textContent).toContain('Done tidying.');
    expect(screen.getByTestId('chat-turn-end').getAttribute('data-reason')).toBe('completed');
  });

  it('history unavailable opens with no earlier turns and one note; truncated heads it with a note', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sessions' }));
    act(() =>
      ws.frame({
        t: 'sessions',
        items: [{ id: 's', title: 'kimi thing', updatedAt: '2026-09-30T09:00:00.000Z' }],
      }),
    );
    await flush();
    fireEvent.click(screen.getAllByTestId('chat-session-row')[0]!);
    act(() => ws.frame({ t: 'ready', session: 's', resumed: true }));
    act(() => ws.frame({ t: 'history', events: [], truncated: true }));
    await flush();
    expect(panel().textContent).toContain(
      'This session’s earlier turns can’t be shown here. Claude Code still has them, so it carries on where you left off.',
    );
    expect(screen.queryAllByTestId('chat-user')).toHaveLength(0);
    act(() => ws.frame({ t: 'history', events: [{ k: 'user', text: 'late' }], truncated: true }));
    await flush();
    expect(panel().textContent).toContain(
      'Earlier turns aren’t shown — only the latest 256 KB of this session is loaded.',
    );
  });

  it('empty, and at the bound of 50', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sessions' }));
    act(() => ws.frame({ t: 'sessions', items: [] }));
    await flush();
    expect(document.body.textContent).toContain(
      'No sessions yet. A chat you start here — or a session you started with Claude Code in the terminal — shows up here.',
    );
    act(() =>
      ws.frame({
        t: 'sessions',
        items: Array.from({ length: 60 }, (_, i) => ({
          id: `s${i}`,
          title: `session ${i}`,
          updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        })),
      }),
    );
    await flush();
    expect(screen.getAllByTestId('chat-session-row')).toHaveLength(50);
    expect(document.body.textContent).toContain('Showing the 50 most recent.');
  });
});

describe('when the agent can’t chat (panel 7)', () => {
  it('aider: Chat is disabled with the Q1 reason, no chat socket opens, and Terminal still connects', async () => {
    expect(CHAT_PROFILES['aider']).toEqual({
      supported: false,
      reason: 'Aider has no machine-readable output for a chat to follow',
    });
    for (const id of ['claude', 'codex', 'opencode', 'kimi', 'goose']) {
      expect(CHAT_PROFILES[id]).toEqual({ supported: true });
    }
    await mount({ openAgentId: 'a3', openTab: 'chat' });
    const tab = screen.getByTestId('agent-chat-tab-disabled');
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    const tip = document.getElementById(tab.getAttribute('aria-describedby')!)!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent).toBe(
      'Chat isn’t available for Aider: it has no machine-readable output for a chat to follow. Use the terminal.',
    );
    fireEvent.click(tab);
    await flush();
    // Even an address naming the chat leaves aider on Terminal.
    expect(tabs().getByRole('button', { name: 'Terminal' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(chatTicketCalls()).toBe(0);
    expect(chatSockets()).toHaveLength(0);
    expect(terminalTicketCalls()).toBe(1);
    expect(terminalSockets()).toHaveLength(1);
  });

  it('a hello refusing subscription_signin draws the Q2 refusal in the design’s words, no error, and Terminal still connects', async () => {
    await mount();
    await openChat();
    const ws = lastChat();
    act(() => ws.accept());
    act(() =>
      ws.frame({
        t: 'hello',
        profile: 'claude',
        supported: false,
        reason: 'subscription_signin',
        signin: 'signed_in',
      }),
    );
    await flush();
    // No open, no prompt box.
    expect(ws.frames.map((f) => f['t'])).toEqual(['auth']);
    expect(within(panel()).queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    const face = screen.getByTestId('chat-face');
    expect(face.textContent).toContain('Chat isn’t available on a Claude subscription');
    expect(face.textContent).toContain(
      'The chat is not available for Claude Code signed in with a Claude subscription, because Anthropic’s terms do not allow a third-party interface to drive it on one.',
    );
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(consoleCalls).toEqual([]);

    // Terminal is untouched: its own socket, live.
    const term = terminalSockets()[0]!;
    act(() => term.accept());
    act(() => term.frame({ t: 'ready', session: 'sess-1', resumed: false }));
    fireEvent.click(within(face).getByRole('button', { name: 'Open Terminal' }));
    await flush();
    expect(tabs().getByRole('button', { name: 'Terminal' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(connWord()).toContain('Live');
  });

  it('not signed in points at the Terminal tab and keeps the prompt; no error', async () => {
    await mount();
    await openChat();
    const ws = await chatLive({ supported: true, signin: 'signed_out' });
    const strip = within(panel()).getByRole('alert');
    expect(strip.textContent).toContain(
      'Claude Code isn’t signed in. Sign in in the Terminal tab — the chat uses the same sign-in.',
    );
    // A prompt refused not_signed_in goes back into the box.
    type('please');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    act(() => ws.frame({ t: 'error', code: 'not_signed_in' }));
    await flush();
    expect((promptBox() as HTMLTextAreaElement).value).toBe('please');
    expect(screen.queryAllByTestId('chat-user')).toHaveLength(0);
    fireEvent.click(within(strip).getByRole('button', { name: 'Open Terminal' }));
    await flush();
    expect(tabs().getByRole('button', { name: 'Terminal' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(consoleCalls).toEqual([]);
  });

  it('close 4411 is the no-chat-server face and does not reconnect; no error', async () => {
    vi.useFakeTimers();
    await mount();
    await openChat();
    act(() => lastChat().drop(TERMINAL_CLOSE.noChatServer));
    await flush();
    expect(connWord()).toContain('Unavailable');
    const face = screen.getByTestId('chat-face');
    expect(face.textContent).toContain('This agent can’t chat yet');
    expect(face.textContent).toContain(
      'It was made from an older image, from before the chat existed.',
    );
    expect(within(face).queryByRole('button')).toBeNull();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_RECONNECT_WINDOW_MS);
    });
    await flush();
    expect(chatTicketCalls()).toBe(1);
    expect(chatSockets()).toHaveLength(1);
    expect(consoleCalls).toEqual([]);
  });
});

describe('refusals in words (panels 5 and 6)', () => {
  it('turn_running and too_large each render their words, and neither empties the box', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    type('second prompt');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    act(() => ws.frame({ t: 'error', code: 'turn_running' }));
    await flush();
    expect(panel().textContent).toContain(
      'A turn is already running on yue-claude, in another chat session. Wait for it to end or stop it there — one turn runs on an agent at a time.',
    );
    expect((promptBox() as HTMLTextAreaElement).value).toBe('second prompt');

    // Over 64 KiB is said before the round trip.
    const before = ws.frames.length;
    type('x'.repeat(64 * 1024 + 1));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    await flush();
    expect(ws.frames.length).toBe(before);
    expect(within(panel()).getByRole('alert').textContent).toContain('This prompt is over 64 KB.');
    expect((promptBox() as HTMLTextAreaElement).value).toHaveLength(64 * 1024 + 1);
  });

  it('taken_over: the transcript dims, the word is Ended, the box is disabled, and Use it here takes it back', async () => {
    await mount();
    await openChat();
    const ws = await chatLive(undefined, { session: 'sess-7', resumed: false });
    act(() => ws.frame({ t: 'error', code: 'taken_over' }));
    await flush();
    expect(connWord()).toContain('Ended');
    expect(panel().textContent).toContain(
      'This chat is open in another tab now. A running turn keeps going there.',
    );
    expect(screen.getByTestId('chat-transcript').className).toContain('opacity-60');
    expect((promptBox() as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Use it here' }));
    await flush();
    const next = lastChat();
    expect(next).not.toBe(ws);
    act(() => next.accept());
    act(() => next.frame({ t: 'hello', profile: 'claude', supported: true, signin: 'signed_in' }));
    expect(next.frames[1]).toEqual({ t: 'open', session: 'sess-7' });
  });

  it('every Q4 code has a disposition', () => {
    expect(Object.keys(CHAT_REFUSAL_WORDS).sort()).toEqual([...CHAT_ERROR_CODES].sort());
    const chat = (enMessages as { myAgents: { panel: { chat: Record<string, unknown> } } }).myAgents
      .panel.chat;
    for (const words of Object.values(CHAT_REFUSAL_WORDS)) {
      if (words.kind === 'silent') continue;
      const value = words.key
        .split('.')
        .slice(1)
        .reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], chat);
      expect(typeof value).toBe('string');
    }
  });
});

describe('the heartbeat (Q9)', () => {
  it('sends the relay’s exact bytes every 20 s: active while visible, inactive when hidden', async () => {
    vi.useFakeTimers();
    await mount();
    await openChat();
    const ws = await chatLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHAT_PING_MS);
    });
    expect(CHAT_PING_MS).toBe(20_000);
    expect(ws.texts[ws.texts.length - 1]).toBe(CHAT_PING_ACTIVE);
    expect(ws.texts[ws.texts.length - 1]).toBe('{"t":"ping","active":true}');
    const pings = () => ws.texts.filter((s) => s.includes('"ping"')).length;
    expect(pings()).toBe(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_PING_MS);
      });
      expect(ws.texts[ws.texts.length - 1]).toBe(CHAT_PING_INACTIVE);
      expect(ws.texts[ws.texts.length - 1]).toBe('{"t":"ping","active":false}');
      expect(pings()).toBe(2);
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
  });
});

describe('wake-then-chat and reconnect (panel 8)', () => {
  it('opening Chat on a hibernated agent calls Wake, then the chat ticket once it reads running — no second click', async () => {
    vi.useFakeTimers();
    let state: AgentInstanceListItemDto['state'] = 'waking';
    routes.list = () => page([agent(), codex({ state })]);
    await mount({
      openAgentId: 'a2',
      openTab: 'chat',
      initial: page([agent(), codex({ state: 'hibernated' })]),
    });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      '/api/projects/MOTIR/instances/a2/wake',
    );
    await flush();
    expect(panel().textContent).toContain('Starting a fresh machine on your home');
    expect(panel().textContent).toContain(
      'The chat connects by itself when it’s up — nothing to click.',
    );
    expect(chatTicketCalls()).toBe(0);

    state = 'running';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();
    expect(chatTicketCalls()).toBe(1);
    await chatLive();
    expect(connWord()).toContain('Live');
  });

  it('clicking Chat on an agent resting hibernated wakes it, as the terminal’s Wake does', async () => {
    await mount();
    const term = terminalSockets()[0]!;
    act(() => term.accept());
    act(() => term.frame({ t: 'ready', session: 'sess-1', resumed: false }));
    await flush();
    // It hibernates on the idle rule while nobody watches: the panel rests, no wake.
    routes.list = () => page([agent({ state: 'hibernated', stopReason: 'idle' })]);
    act(() => term.drop(TERMINAL_CLOSE.notRunning));
    await flush();
    const wakes = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/a1/wake')).length;
    expect(wakes()).toBe(0);
    expect(panel().textContent).toContain('yue-claude is hibernated');
    await openChat();
    expect(wakes()).toBe(1);
    expect(chatTicketCalls()).toBe(0);
  });

  it('a dropped socket shows reconnecting and reconnects to the same session', async () => {
    vi.useFakeTimers();
    await mount();
    await openChat();
    const first = await chatLive(undefined, { session: 'sess-42', resumed: false });
    ev(first, 1, { k: 'user', text: 'long build' });
    await flush();
    act(() => first.drop(1006));
    await flush();
    expect(connWord()).toContain('Reconnecting…');
    expect(panel().textContent).toContain(
      'Connection dropped — reconnecting. A running turn keeps going on the agent.',
    );
    expect(screen.getByTestId('chat-transcript').className).toContain('opacity-60');
    expect((promptBox() as HTMLTextAreaElement).disabled).toBe(true);
    expect(panel().textContent).toContain('You can type again once the chat reconnects.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    const second = lastChat();
    expect(second).not.toBe(first);
    act(() => second.accept());
    act(() =>
      second.frame({ t: 'hello', profile: 'claude', supported: true, signin: 'signed_in' }),
    );
    expect(second.frames[1]).toEqual({ t: 'open', session: 'sess-42' });
    act(() => second.frame({ t: 'ready', session: 'sess-42', resumed: true }));
    act(() =>
      second.frame({ t: 'history', events: [{ k: 'user', text: 'long build' }], truncated: false }),
    );
    await flush();
    expect(connWord()).toContain('Live');
    expect(screen.getAllByTestId('chat-user').map((r) => r.textContent)).toEqual(['long build']);
    // A reconnect is not a resume the reader chose: no Resumed chip.
    expect(within(panel()).queryByText('Resumed')).toBeNull();
  });

  it('after the reconnect window it is lost, with Reconnect', async () => {
    vi.useFakeTimers();
    await mount();
    await openChat();
    await chatLive();
    routes.chatTicket = () => json(502, {});
    act(() => lastChat().drop(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_RECONNECT_WINDOW_MS + 15_000);
    });
    await flush();
    expect(connWord()).toContain('Disconnected');
    const alert = within(panel()).getByRole('alert');
    expect(alert.textContent).toContain(
      'Couldn’t reconnect. A running turn keeps going on the agent — reconnect to pick it up.',
    );
    routes.chatTicket = () => json(200, CHAT_TICKET);
    const before = chatTicketCalls();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reconnect' }));
    await flush();
    expect(chatTicketCalls()).toBe(before + 1);
  });
});

describe('nothing leaves the page (Q10)', () => {
  it('a transcript carrying a known string reaches no Sentry call, no console call and no storage', async () => {
    const MARKER = 'SECRET-TRANSCRIPT-7017';
    await mount();
    await openChat();
    const ws = await chatLive();
    type(`prompt ${MARKER}`);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    ev(ws, 1, { k: 'user', text: `prompt ${MARKER}` });
    ev(ws, 1, { k: 'text', id: 'm', delta: `reply ${MARKER}` });
    ev(ws, 1, {
      k: 'tool_call',
      id: 't',
      kind: 'command',
      name: 'Bash',
      title: MARKER,
      command: MARKER,
    });
    ev(ws, 1, {
      k: 'tool_result',
      id: 't',
      ok: false,
      output: MARKER,
      exitCode: 2,
      truncated: false,
    });
    ev(ws, 1, { k: 'error', code: 'x', message: MARKER });
    ev(ws, 1, { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' });
    act(() =>
      ws.frame({
        t: 'sessions',
        items: [{ id: 's', title: MARKER, updatedAt: '2026-09-30T00:00:00Z' }],
      }),
    );
    act(() => ws.frame({ t: 'bogus', payload: MARKER }));
    await flush();
    fireEvent.click(within(screen.getByTestId('chat-tool-row')).getByRole('button'));
    expect(panel().textContent).toContain(`reply ${MARKER}`);

    const everything = JSON.stringify({ sentry: sentry.calls, console: consoleCalls });
    expect(everything).not.toContain(MARKER);
    expect(sentry.calls).toEqual([]);
    expect(consoleCalls).toEqual([]);
    const dump = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join('\n');
    expect(`${dump(window.sessionStorage)}\n${dump(window.localStorage)}`).not.toContain(MARKER);
    expect(window.localStorage.length).toBe(0);
  });

  it('a tool’s output is text, never markup', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    ev(ws, 1, {
      k: 'tool_call',
      id: 't',
      kind: 'command',
      name: 'Bash',
      title: 'cat',
      command: 'cat x.html',
    });
    ev(ws, 1, {
      k: 'tool_result',
      id: 't',
      ok: true,
      output: '<img src=x onerror="alert(1)"><b>bold</b>',
      exitCode: 0,
      truncated: true,
    });
    ev(ws, 1, {
      k: 'text',
      id: 'm',
      delta: 'Look: <img src=x onerror="alert(1)"> <script>alert(2)</script>',
    });
    await flush();
    const row = screen.getByTestId('chat-tool-row');
    fireEvent.click(within(row).getByRole('button'));
    const body = within(row).getByTestId('chat-tool-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('<b>bold</b>');
    expect(body.textContent).toContain('Output clipped — showing the last 64 KB.');
    const text = screen.getByTestId('chat-text');
    expect(text.querySelector('script')).toBeNull();
    expect(text.querySelector('img[onerror]')).toBeNull();
  });

  it('a long output is clipped, with an expand', async () => {
    await mount();
    await openChat();
    const ws = await chatLive();
    const output = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n');
    ev(ws, 1, {
      k: 'tool_call',
      id: 't',
      kind: 'command',
      name: 'Bash',
      title: 'seq',
      command: 'seq',
    });
    ev(ws, 1, { k: 'tool_result', id: 't', ok: true, output, exitCode: 0, truncated: false });
    await flush();
    const row = screen.getByTestId('chat-tool-row');
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByTestId('chat-tool-body').textContent).not.toContain('line 449');
    fireEvent.click(within(row).getByRole('button', { name: 'Show all 450 lines' }));
    expect(within(row).getByTestId('chat-tool-body').textContent).toContain('line 449');
  });
});

describe('every string in en and zh', () => {
  const flatten = (node: unknown, prefix = ''): string[] =>
    typeof node === 'string'
      ? [prefix]
      : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
          flatten(v, prefix ? `${prefix}.${k}` : k),
        );
  const chatOf = (m: unknown) =>
    (m as { myAgents: { panel: { chat: unknown; tabs: Record<string, string> } } }).myAgents.panel;

  it('the chat namespace has the same keys, every one a non-empty string, in both catalogs', () => {
    const en = flatten(chatOf(enMessages).chat).sort();
    const zh = flatten(chatOf(zhMessages).chat).sort();
    expect(en.length).toBeGreaterThan(40);
    expect(zh).toEqual(en);
    expect(chatOf(enMessages).tabs['chat']).toBe('Chat');
    expect(chatOf(zhMessages).tabs['chat']).toBe('对话');
  });

  it('renders the chat in Chinese from the zh catalog, with no missing message', async () => {
    await mount({ messages: zhMessages });
    fireEvent.click(tabs_zh().getByRole('button', { name: '对话' }));
    await flush();
    const ws = await chatLive();
    ev(ws, 1, { k: 'user', text: 'hi' });
    ev(ws, 1, { k: 'turn_end', reason: 'completed' });
    await flush();
    expect(panel().textContent).toContain('本轮完成');
    expect(within(panel()).getByRole('textbox', { name: '提示' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '会话' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '新对话' })).toBeTruthy();
    expect(panel().textContent).toContain('Enter 发送 · Shift+Enter 换行');
    expect(consoleCalls).toEqual([]);
  });
});

function tabs_zh() {
  return within(within(panel()).getByRole('navigation'));
}
