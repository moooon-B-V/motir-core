// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { WebSocket as NodeWebSocket } from 'ws';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { CHAT_PROFILES } from '@/lib/agentInstances/profiles';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import type { ChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapter';
import { createClaudeChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapters/claude';
import { codexChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapters/codex';
import { gooseChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapters/goose';
import { kimiAdapter } from '../../packages/cli/src/agentTerminal/chat/adapters/kimi';
import { opencodeChatAdapter } from '../../packages/cli/src/agentTerminal/chat/adapters/opencode';
import {
  newNonce,
  relayAuthorizationHeader,
  signRelayToken,
} from '../../packages/cli/src/agentTerminal/relayToken';
import {
  createTerminalServer,
  type TerminalServer,
} from '../../packages/cli/src/agentTerminal/server';
import { fakeChatSpawner, fakePtySpawner, type FakeChatProcess } from './_chatFakes';

// THE AGENT-CHAT STORY GATE, the tab's half (Story MOTIR-6863 · MOTIR-7018,
// `docs/decisions/agent-chat.md` Q1, Q2, Q5, Q8).
//
// For each of the FIVE adapters, each recorded stream is replayed through the
// REAL in-agent server (`createTerminalServer`, the real adapter, the real turn
// runner; only the turn PROCESS is a fake that prints the recording) over a REAL
// WebSocket, and the text frames that come back are handed — byte for byte, in
// order — to the Chat tab (`MyAgentsRoom`, the tab the page renders). What is
// asserted is what the ADR's mapping promises the user sees: one row per tool
// call, of its kind, marked failed when its result failed; and one turn-end
// marker, of the reason the runner decided.
//
// The node half of the gate (ticket route → relay → server, owner-only, activity,
// the never-logged guards) is `agentChatStoryGate.test.ts`.

// ── Sentry, recorded at its module boundary ─────────────────────────────────
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

const REPO = resolve(__dirname, '..', '..');
const FIXTURES = join(REPO, 'packages', 'cli', 'test', 'agentTerminal', 'fixtures', 'chat');
const PROMPT = 'Replay the recording, please';

// ── The browser's socket: a fake the tab dials, fed the server's real bytes ──

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
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
  /** One text frame, exactly as the server wrote it. */
  deliver(text: string) {
    this.onmessage?.({ data: text });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const chatSockets = () => FakeSocket.instances.filter((s) => s.url.endsWith('/v1/chat'));
const terminalSockets = () => FakeSocket.instances.filter((s) => s.url.endsWith('/v1/terminal'));

const PROFILE_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  goose: 'Goose',
};

function agent(profileId: string): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: `yue-${profileId}`,
    projectId: 'p1',
    profileId,
    profileName: PROFILE_NAMES[profileId] ?? profileId,
    imageTag: `ghcr.io/moooon-b-v/motir-sandbox:${profileId}`,
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
    activeRun: null,
    lastRun: null,
    scheduledDeletionAt: null,
  };
}

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
const CHAT_TICKET = { url: 'wss://relay.motir.test/v1/chat', ticket: 'chat-t', expiresAt: 'x' };
const TERMINAL_TICKET = {
  url: 'wss://relay.motir.test/v1/terminal',
  ticket: 'term-t',
  expiresAt: 'x',
};
let listed: AgentInstanceListItemDto[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/terminal-ticket')) {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { channel?: string }) : {};
    return json(200, body.channel === 'chat' ? CHAT_TICKET : TERMINAL_TICKET);
  }
  return json(200, { instances: listed, total: listed.length });
});

const consoleCalls: unknown[][] = [];

beforeEach(() => {
  fetchMock.mockClear();
  FakeSocket.instances = [];
  sentry.calls.length = 0;
  consoleCalls.length = 0;
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

const harnesses: Harness[] = [];
const homes: string[] = [];
afterEach(async () => {
  // No test here may print: an act() warning is a real finding.
  const printed = consoleCalls.map((c) => String(c[1]).slice(0, 200));
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const h of harnesses.splice(0)) await h.terminal.close();
  expect(printed).toEqual([]);
});
afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Wait, on the real clock, for a condition real I/O satisfies — never a fixed sleep. */
async function until<T>(check: () => T | undefined | null | false, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── The real server, and a real socket to it ────────────────────────────────

const KEY = 'chat-tab-gate-7018-instance-key';
const INSTANCE = 'inst_chat_tab_gate';
const MACHINE = 'mach_chat_tab_gate';

interface Harness {
  terminal: TerminalServer;
  port: number;
  /** Every chat turn process the runner started — the spawn seam. */
  chatProcs: FakeChatProcess[];
  /** A fresh relay token for this server, as the relay would sign one. */
  token(): string;
}

async function startServer(profile: string, adapter: ChatAdapter): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), `motir-chat-tab-${profile}-`));
  mkdirSync(join(home, 'workspace'));
  homes.push(home);
  const chat = fakeChatSpawner();
  const terminal = createTerminalServer({
    instanceKey: KEY,
    instanceId: INSTANCE,
    machineId: MACHINE,
    spawnPty: fakePtySpawner().spawn,
    spawnChat: chat.spawn,
    chatAdapters: [adapter],
    // A stand-in PATH with nothing on it: no vendor binary is ever reachable.
    env: {
      HOME: home,
      MOTIR_SANDBOX_AGENT: profile,
      PATH: join(home, 'no-bin'),
    } as unknown as NodeJS.ProcessEnv,
    // Signed in, as far as the credential stat can tell.
    stat: async () => ({ isFile: () => true, size: 10 }),
    log: () => {},
  });
  const port = await terminal.listen(0, '127.0.0.1');
  const h: Harness = {
    terminal,
    port,
    chatProcs: chat.procs,
    token: () =>
      signRelayToken(KEY, {
        instanceId: INSTANCE,
        machineId: MACHINE,
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: newNonce(),
      }),
  };
  harnesses.push(h);
  return h;
}

interface Wire {
  /** Every text frame the server wrote, as the bytes it wrote. */
  raw: string[];
  ws: NodeWebSocket;
  send(frame: Record<string, unknown>): void;
  frame(t: string): Promise<Record<string, unknown>>;
}

async function connect(h: Harness): Promise<Wire> {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${h.port}/v1/chat`, {
    headers: { Authorization: relayAuthorizationHeader(h.token()) },
  });
  const wire: Wire = {
    raw: [],
    ws,
    send: (frame) => ws.send(JSON.stringify(frame)),
    frame: (t) =>
      until(() =>
        wire.raw
          .map((text) => JSON.parse(text) as Record<string, unknown>)
          .find((f) => f['t'] === t),
      ),
  };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) wire.raw.push(Buffer.from(data as Buffer).toString('utf8'));
  });
  await new Promise<void>((ok, fail) => {
    ws.once('open', () => ok());
    ws.once('error', fail);
  });
  return wire;
}

interface Recording {
  file: string;
  lines: string[];
  /** The code the recorded CLI exited with; whether the user pressed Stop first. */
  exit: number;
  stop: boolean;
}

/** A fixture's stream lines, its header dropped, and how the recorded run ended. */
function recording(profile: string, file: string, how: { exit?: number; stop?: boolean } = {}) {
  const text = readFileSync(join(FIXTURES, profile, file), 'utf8');
  const [header, ...lines] = text.split('\n').filter((line) => line.length > 0);
  if (profile === 'kimi') {
    // kimi's header is JSON and says how its run ended.
    const meta = JSON.parse(header as string) as { exit: number; stop?: boolean };
    return { file, lines, exit: meta.exit, stop: meta.stop === true } satisfies Recording;
  }
  expect(header).toMatch(/^# /);
  return { file, lines, exit: how.exit ?? 0, stop: how.stop ?? false } satisfies Recording;
}

/** One turn through the real server: prompt, (Stop), the recording, the exit — to turn_end. */
async function replay(profile: string, adapter: ChatAdapter, rec: Recording): Promise<string[]> {
  const h = await startServer(profile, adapter);
  const wire = await connect(h);
  await wire.frame('hello');
  wire.send({ t: 'open' });
  await wire.frame('ready');
  wire.send({ t: 'prompt', text: PROMPT });
  const proc = await until(() => h.chatProcs[0] as FakeChatProcess | undefined);
  if (rec.stop) {
    wire.send({ t: 'stop' });
    await until(() => proc.signals.includes('SIGINT'));
  }
  for (const line of rec.lines) {
    // A process the runner killed prints nothing more.
    if (proc.exited) break;
    proc.line(line);
  }
  proc.exit(rec.exit);
  await until(() =>
    wire.raw.some((text) => {
      const f = JSON.parse(text) as { t: string; e?: { k: string } };
      return f.t === 'event' && f.e?.k === 'turn_end';
    }),
  );
  wire.ws.close();
  return wire.raw;
}

// ── The tab ─────────────────────────────────────────────────────────────────

async function mountChat(profile: string) {
  listed = [agent(profile)];
  render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={{ instances: listed, total: 1, planLapse: null }}
      profiles={Object.entries(PROFILE_NAMES).map(([id, name]) => ({ id, name }))}
      maxPerUser={10}
      openAgentId="a1"
      openTab="chat"
    />,
  );
  await flush();
  const ws = await until(() => chatSockets()[0]);
  act(() => ws.accept());
  return ws;
}

/** Hand the tab every frame the server wrote, verbatim and in order. */
async function play(ws: FakeSocket, raw: string[]) {
  for (const text of raw) act(() => ws.deliver(text));
  await flush();
}

type Parsed = { t: string; e?: Record<string, unknown> };
const events = (raw: string[]) =>
  raw
    .map((text) => JSON.parse(text) as Parsed)
    .filter((f) => f.t === 'event')
    .map((f) => f.e as Record<string, unknown>);

// ── The promise, fixture by fixture ─────────────────────────────────────────
//
// Written down by hand from each fixture's README and the ADR's mapping (Q1's
// per-adapter rows, Q5's turn end): the tool rows, by kind and in order, the
// failed ones among them, and the turn's end. A mapper that dropped or re-kinded
// a call, or a runner that decided a different end, fails here.

interface Promise_ {
  kinds: string[];
  failed: number;
  end: string;
  code?: string;
  exit?: number;
  stop?: boolean;
}

const PROMISED: Record<string, Record<string, Promise_>> = {
  claude: {
    'bash.jsonl': { kinds: ['command'], failed: 0, end: 'completed' },
    'edit.jsonl': { kinds: ['edit'], failed: 0, end: 'completed' },
    'failed-tool.jsonl': { kinds: ['command'], failed: 1, end: 'completed' },
    'read.jsonl': { kinds: ['read'], failed: 0, end: 'completed' },
    'resume.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'text-reply.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'unknown-line.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'stopped.jsonl': { kinds: [], failed: 0, end: 'stopped', stop: true },
    'no-key.jsonl': { kinds: [], failed: 0, end: 'failed', code: 'subscription_signin' },
  },
  codex: {
    'command.jsonl': { kinds: ['command'], failed: 0, end: 'completed' },
    'failed-command.jsonl': { kinds: ['command'], failed: 1, end: 'completed' },
    'file-change.jsonl': { kinds: ['edit', 'edit', 'edit'], failed: 0, end: 'completed' },
    'message.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'other-events.jsonl': { kinds: ['other', 'other'], failed: 0, end: 'completed' },
    'resume.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'interrupted.jsonl': { kinds: ['command'], failed: 0, end: 'stopped', exit: 1, stop: true },
    'turn-failed.jsonl': { kinds: [], failed: 0, end: 'failed', code: 'exit_nonzero', exit: 1 },
  },
  opencode: {
    'continued-session.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'failed-tool.jsonl': { kinds: ['read'], failed: 1, end: 'completed' },
    'plain-reply.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'read-edit-command.jsonl': { kinds: ['read', 'edit', 'command'], failed: 0, end: 'completed' },
    'stopped.jsonl': { kinds: [], failed: 0, end: 'stopped', exit: 130, stop: true },
  },
  // kimi's header carries its own exit and Stop; the table does not repeat them.
  kimi: {
    'failed-tool.jsonl': { kinds: ['command'], failed: 1, end: 'completed' },
    'plain-reply.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'resumed.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'stopped.jsonl': { kinds: [], failed: 0, end: 'stopped' },
    'tools.jsonl': { kinds: ['read', 'edit', 'command'], failed: 0, end: 'completed' },
  },
  goose: {
    'failed-tool.jsonl': { kinds: ['command', 'read'], failed: 2, end: 'completed' },
    'plain-reply.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'resumed.jsonl': { kinds: [], failed: 0, end: 'completed' },
    'shell-and-edit.jsonl': { kinds: ['command', 'edit'], failed: 0, end: 'completed' },
    'stopped.jsonl': { kinds: [], failed: 0, end: 'stopped', exit: 1, stop: true },
  },
};

const ADAPTERS: Record<string, () => ChatAdapter> = {
  claude: () =>
    createClaudeChatAdapter({
      probe: async () => readFileSync(join(FIXTURES, 'claude', 'auth-status-api-key.json'), 'utf8'),
    }),
  codex: () => codexChatAdapter,
  opencode: () => opencodeChatAdapter,
  kimi: () => kimiAdapter,
  goose: () => gooseChatAdapter,
};

/** The token and cost fields the recordings carry — none may reach a frame (Q10's "no usage"). */
const USAGE_KEYS = [
  'total_cost_usd',
  'usage',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
  'total_tokens',
  'cost',
  'tokens',
];
const usageKeysIn = (text: string) => USAGE_KEYS.filter((key) => text.includes(`"${key}":`));

/** The sentence each non-completed end draws (the tab's own words, `en.json`). */
const END_WORDS: Record<string, (name: string) => string> = {
  stopped: () => 'You stopped this turn. The reply above is as far as it got.',
  subscription_signin: () =>
    'Claude Code is signed in with a Claude subscription, which the chat can’t use.',
  exit_nonzero: (name) => `${name} stopped unexpectedly (exit_nonzero).`,
};

const streamFiles = (profile: string) =>
  readdirSync(join(FIXTURES, profile))
    .filter((name) => name.endsWith('.jsonl') && name !== 'session_index.jsonl')
    .sort();

describe('each adapter’s recorded stream, over the real socket, drawn by the Chat tab', () => {
  it('the gate covers the five chat profiles, and promises every stream fixture each one has', () => {
    expect(Object.keys(PROMISED).sort()).toEqual(['claude', 'codex', 'goose', 'kimi', 'opencode']);
    for (const profile of Object.keys(PROMISED)) {
      expect(CHAT_PROFILES[profile]).toEqual({ supported: true });
      expect(Object.keys(PROMISED[profile]!).sort()).toEqual(streamFiles(profile));
    }
  });

  for (const [profile, fixtures] of Object.entries(PROMISED)) {
    describe(profile, () => {
      for (const [file, promise] of Object.entries(fixtures)) {
        it(`${file}: ${promise.kinds.length} tool row(s) [${promise.kinds.join(', ')}], ${promise.failed} failed, ending ${promise.end}${promise.code ? ` (${promise.code})` : ''}`, async () => {
          const rec = recording(profile, file, { exit: promise.exit, stop: promise.stop });
          const raw = await replay(profile, ADAPTERS[profile]!(), rec);

          // The wire: what the adapter and the runner decided.
          const wire = events(raw);
          expect(wire[0]).toEqual({ k: 'user', text: PROMPT });
          expect(wire.filter((e) => e['k'] === 'tool_call').map((e) => e['kind'])).toEqual(
            promise.kinds,
          );
          expect(wire.at(-1)).toEqual({
            k: 'turn_end',
            reason: promise.end,
            ...(promise.code ? { code: promise.code } : {}),
          });
          // No token or cost field reaches a frame.
          expect(raw.flatMap(usageKeysIn)).toEqual([]);

          // The tab: those exact bytes, drawn.
          const ws = await mountChat(profile);
          await play(ws, raw);
          const panel = screen.getByTestId('agent-panel');
          expect(
            within(panel)
              .getAllByTestId('chat-user')
              .map((u) => u.textContent),
          ).toEqual([PROMPT]);
          // One row per tool call, of its kind, in order.
          const rows = within(panel).queryAllByTestId('chat-tool-row');
          expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(promise.kinds);
          // Failed where its result failed, and only there.
          expect(rows.filter((r) => r.getAttribute('data-failed') === 'true')).toHaveLength(
            promise.failed,
          );
          expect(wire.filter((e) => e['k'] === 'tool_result' && e['ok'] === false)).toHaveLength(
            promise.failed,
          );
          // Every non-tool event the stream carried has its own row.
          const count = (k: string) => wire.filter((e) => e['k'] === k).length;
          expect(within(panel).queryAllByTestId('chat-error')).toHaveLength(count('error'));
          expect(within(panel).queryAllByTestId('chat-other')).toHaveLength(count('other'));
          expect(within(panel).queryAllByTestId('chat-text').length > 0).toBe(count('text') > 0);
          // One end marker, of the runner's reason — in its own words.
          const ends = within(panel).getAllByTestId('chat-turn-end');
          expect(ends.map((e) => e.getAttribute('data-reason'))).toEqual([promise.end]);
          const words = END_WORDS[promise.code ?? promise.end];
          if (words) expect(ends[0]!.textContent).toContain(words(PROFILE_NAMES[profile]!));
          // The chat was never refused, and the turn is over: Send is back.
          expect(screen.queryByTestId('chat-face')).toBeNull();
          expect(within(panel).getByRole('button', { name: 'Send' })).toBeTruthy();
          expect(sentry.calls).toEqual([]);
        }, 30_000);
      }
    });
  }

  it('the usage guard can fail: the recordings DO carry token and cost fields, which the frames drop', () => {
    const carried = Object.keys(PROMISED).flatMap((profile) =>
      streamFiles(profile).flatMap((file) =>
        usageKeysIn(readFileSync(join(FIXTURES, profile, file), 'utf8')),
      ),
    );
    for (const key of ['total_cost_usd', 'usage', 'input_tokens', 'total_tokens', 'cost']) {
      expect(carried).toContain(key);
    }
    expect(usageKeysIn('{"usage":{"input_tokens":3}}')).toEqual(['usage', 'input_tokens']);
  });
});

// ── Claude Code on a Claude subscription (Q2 option b) ──────────────────────

describe('Claude Code on a Claude subscription, drawn', () => {
  it('the real server’s hello refuses subscription_signin; the tab draws the refusal, and Terminal still connects', async () => {
    const auth = readFileSync(join(FIXTURES, 'claude', 'auth-status-subscription.json'), 'utf8');
    const h = await startServer('claude', createClaudeChatAdapter({ probe: async () => auth }));
    const wire = await connect(h);
    const hello = await wire.frame('hello');
    expect(hello).toMatchObject({ t: 'hello', supported: false, reason: 'subscription_signin' });
    // A chat opened and prompted anyway is refused with that code, and nothing is spawned.
    wire.send({ t: 'open' });
    await wire.frame('ready');
    wire.send({ t: 'prompt', text: PROMPT });
    expect(await wire.frame('error')).toEqual({ t: 'error', code: 'subscription_signin' });
    expect(h.chatProcs).toHaveLength(0);
    wire.ws.close();

    const ws = await mountChat('claude');
    await play(ws, wire.raw);
    // The tab opened nothing on a refusal.
    expect(ws.frames.map((f) => f['t'])).toEqual(['auth']);
    const panel = screen.getByTestId('agent-panel');
    expect(within(panel).queryByRole('textbox', { name: 'Prompt' })).toBeNull();
    const face = screen.getByTestId('chat-face');
    expect(face.textContent).toContain('Chat isn’t available on a Claude subscription');
    expect(within(panel).queryByRole('alert')).toBeNull();

    // Terminal is untouched: its own ticket, its own socket, live.
    fireEvent.click(within(face).getByRole('button', { name: 'Open Terminal' }));
    await flush();
    const term = await until(() => terminalSockets()[0]);
    act(() => term.accept());
    act(() => term.deliver(JSON.stringify({ t: 'ready', session: 'sess-1', resumed: false })));
    await flush();
    expect(screen.getByTestId('agent-conn').textContent).toContain('Live');
  }, 30_000);
});

// ── An old image (Q8) ───────────────────────────────────────────────────────

describe('an image with no chat server, drawn', () => {
  let old: http.Server | null = null;
  let relay: TerminalRelay | null = null;
  afterEach(async () => {
    await relay?.close();
    await new Promise<void>((ok) => (old ? old.close(() => ok()) : ok()));
    relay = null;
    old = null;
  });

  it('the real relay closes 4411 when the machine 404s /v1/chat, and the tab draws the no-chat-server face', async () => {
    // The machine: a terminal server from before the chat, which 404s the path.
    const upgrades: string[] = [];
    old = http.createServer((_req, res) => res.writeHead(404).end());
    old.on('upgrade', (req, socket) => {
      upgrades.push(req.url ?? '');
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((ok) => old!.listen(0, '127.0.0.1', ok));
    const machine = `ws://127.0.0.1:${(old.address() as AddressInfo).port}`;
    const logs: string[] = [];
    const closes: number[] = [];
    const reported: Error[] = [];
    relay = createTerminalRelay({
      allowedOrigin: 'https://motir.test',
      authorize: async (_ticket, channel) => ({
        ok: true,
        target: {
          instanceId: 'a1',
          userId: 'u1',
          workspaceId: 'w1',
          channel,
          dial: { url: `${machine}/v1/${channel}`, headers: {} },
        },
      }),
      openConnection: async () => 'conn-1',
      closeConnection: async (input) => {
        closes.push(input.closeCode);
      },
      touchActivity: async () => {},
      heartbeat: async () => {},
      log: (line) => logs.push(line),
      reportError: (err) => reported.push(err),
      now: () => 0,
    });
    await new Promise<void>((ok) => relay!.server.listen(0, '127.0.0.1', ok));
    const browser = new NodeWebSocket(
      `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/chat`,
      { origin: 'https://motir.test' },
    );
    const closed = new Promise<number>((ok) => browser.on('close', (code) => ok(code)));
    await new Promise<void>((ok, fail) => {
      browser.once('open', () => ok());
      browser.once('error', fail);
    });
    browser.send(JSON.stringify({ t: 'auth', ticket: 'chat-t' }));
    const code = await closed;
    expect(code).toBe(TERMINAL_CLOSE.noChatServer);
    expect(upgrades).toEqual(['/v1/chat']);
    await until(() => closes.length > 0);
    expect(closes).toEqual([TERMINAL_CLOSE.noChatServer]);
    // Recorded, not reported: an old image is not a failure.
    expect(reported).toEqual([]);
    expect(logs.some((line) => line.includes('no_chat_server'))).toBe(true);

    // The tab, handed that close code.
    const ws = await mountChat('claude');
    act(() => ws.drop(code));
    await flush();
    expect(screen.getByTestId('agent-conn').textContent).toContain('Unavailable');
    const face = screen.getByTestId('chat-face');
    expect(face.textContent).toContain('This agent can’t chat yet');
    expect(face.textContent).toContain(
      'It was made from an older image, from before the chat existed.',
    );
  }, 30_000);
});
