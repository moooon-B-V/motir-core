// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom, RUN_POLL_MS } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import {
  parseSessionListings,
  TERMINAL_PING_MS,
  TERMINAL_RECONNECT_WINDOW_MS,
} from '@/app/(authed)/my-agents/_components/useAgentTerminal';
import type {
  AgentInstanceActiveRunDto,
  AgentInstanceLastRunDto,
  AgentInstanceListItemDto,
  AgentInstanceListPageDto,
} from '@/lib/dto/agentInstances';

// MY AGENTS SHOWS THE AGENT'S LIVE RUN (Story MOTIR-6864 · MOTIR-7029), held to the
// approved `design/my-agents/my-agents--run.mock.html` (MOTIR-7022) and its section
// of `design/my-agents/design-notes.md`. The same seams as the panel's own suite
// (`AgentPanel.test.tsx`): the routes at `fetch`, the relay at `WebSocket`, xterm
// at its module. What is asserted: the run line (live and last), Hibernate and
// Delete held off, the run's session offered beside the shell and watched over a
// SECOND socket through the same ticket route, its end from both directions, the
// refusal naming the run, the narrow width and the zh catalog.

// ── xterm, at the module boundary ──────────────────────────────────────────
const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    written: Uint8Array[];
    resets: number;
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    disposed: boolean;
    fireData: (data: string) => void;
    fireResize: (cols: number, rows: number) => void;
  }>,
}));
vi.mock('@xterm/xterm', () => {
  class Terminal {
    written: Uint8Array[] = [];
    resets = 0;
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    disposed = false;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    private dataCb: ((d: string) => void) | null = null;
    private resizeCb: ((s: { cols: number; rows: number }) => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    write(bytes: Uint8Array) {
      this.written.push(bytes);
    }
    reset() {
      this.resets += 1;
    }
    dispose() {
      this.disposed = true;
    }
    scrollToBottom() {}
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
    }
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      this.resizeCb = cb;
    }
    onScroll() {}
    onWriteParsed() {}
    fireData(data: string) {
      this.dataCb?.(data);
    }
    fireResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeCb?.({ cols, rows });
    }
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
  /** Server side. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  bytes(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
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
const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

// ── fixtures ───────────────────────────────────────────────────────────────
const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'kimi', name: 'Kimi Code' },
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
    imageVersion: '1.0.0',
    update: null,
    pendingImageVersion: null,
    updateFailureReason: null,
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
    scheduledDeletionAt: null,
    activeRun: null,
    lastRun: null,
    ...over,
  };
}
const codex = (over: Partial<AgentInstanceListItemDto> = {}) =>
  agent({ id: 'a2', name: 'yue-codex', profileId: 'codex', profileName: 'Codex', ...over });

const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
  planLapse: null,
});

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const TICKET = { url: 'wss://relay.motir.test/v1/terminal', ticket: 't0k3n', expiresAt: 'x' };

/** Routes the stubbed fetch answers; each test overrides what it needs. */
let routes: {
  list: () => AgentInstanceListPageDto;
  ticket: () => Response;
  wake: () => Response;
  hibernate: () => Response;
  del: () => Response;
};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (url.endsWith('/terminal-ticket')) return routes.ticket();
  if (url.endsWith('/wake')) return routes.wake();
  if (url.endsWith('/hibernate')) return routes.hibernate();
  if (method === 'DELETE') return routes.del();
  return json(200, routes.list());
});
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
  }));
const ticketCalls = () => calls().filter((c) => c.url.endsWith('/terminal-ticket')).length;

beforeEach(() => {
  fetchMock.mockClear();
  FakeSocket.instances = [];
  xterm.instances.length = 0;
  routes = {
    list: () => page([agent(), codex({ state: 'hibernated' })]),
    ticket: () => json(200, TICKET),
    wake: () => json(202, {}),
    hibernate: () => json(202, {}),
    del: () => json(204, null),
  };
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/my-agents');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let fetches, dynamic imports and the effects they trigger settle. */
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  initial: AgentInstanceListPageDto = routes.list(),
  opts: { openAgentId?: string | null; messages?: Record<string, unknown> } = {},
) {
  const result = render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={initial}
      profiles={PROFILES}
      maxPerUser={10}
      openAgentId={opts.openAgentId ?? null}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
  await flush();
  return result;
}

/** Accept the latest socket and attach it to a shell. */
async function goLive(session = 'sess-1', resumed = false) {
  const ws = lastSocket();
  act(() => ws.accept());
  act(() => ws.frame({ t: 'ready', session, resumed }));
  await flush();
  return ws;
}

const panel = () => screen.getByTestId('agent-panel');

// ── the run fixtures ───────────────────────────────────────────────────────
const RUN: AgentInstanceActiveRunDto = {
  id: 'run-1',
  workItemKey: 'MOTIR-1789',
  title: 'The run section names the agent it ran in',
  startedAt: '2026-09-30T10:00:00.000Z',
};
const lastRun = (over: Partial<AgentInstanceLastRunDto> = {}): AgentInstanceLastRunDto => ({
  id: 'run-1',
  workItemKey: 'MOTIR-1789',
  title: 'The run section names the agent it ran in',
  status: 'succeeded',
  endedAt: '2026-09-30T10:30:00.000Z',
  reason: null,
  ...over,
});
const busy = (over: Partial<AgentInstanceListItemDto> = {}) => agent({ activeRun: RUN, ...over });

const SHELL = { session: 'sess-1', kind: 'shell' };
const RUN_SESSION = { session: 'run-sess', kind: 'run', runId: 'run-1' };

const runLine = () => screen.queryByTestId('agent-run-line');
const sessionSwitch = () => within(panel()).queryByRole('group', { name: 'Terminal sessions' });

/** Open the busy agent, attach its shell, and have the server list the run session. */
async function openBusyAndList() {
  routes.list = () => page([busy(), codex({ state: 'hibernated' })]);
  await mount(routes.list(), { openAgentId: 'a1' });
  const shell = await goLive();
  act(() => shell.frame({ t: 'sessions', sessions: [SHELL, RUN_SESSION] }));
  await flush();
  return shell;
}

/** Choose the run's session and let its socket attach; returns the watch socket. */
async function watchRun() {
  fireEvent.click(within(sessionSwitch()!).getByRole('button', { name: /Run MOTIR-1789/ }));
  await flush();
  const watch = lastSocket();
  act(() => watch.accept());
  act(() =>
    watch.frame({ t: 'ready', session: 'run-sess', resumed: true, kind: 'run', runId: 'run-1' }),
  );
  await flush();
  return watch;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the run line (panel 1)', () => {
  it('names the running work item, links it and its run; Hibernate and Delete are off with the reason', async () => {
    routes.list = () => page([busy(), codex({ state: 'hibernated' })]);
    await mount(routes.list(), { openAgentId: 'a1' });

    const line = runLine()!;
    expect(line.getAttribute('data-state')).toBe('live');
    expect(line.className).toContain('bg-(--el-tint-sky)');
    expect(line.textContent).toContain('Running a work item');
    expect(line.textContent).toContain('The run section names the agent it ran in');
    expect(within(line).getByRole('link', { name: 'MOTIR-1789' }).getAttribute('href')).toBe(
      '/items/MOTIR-1789',
    );
    expect(within(line).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      '/runs?run=run-1',
    );
    expect(line.parentElement!.getAttribute('aria-live')).toBe('polite');

    const hibernate = within(panel()).getByRole('button', { name: /Hibernate/ });
    const del = within(panel()).getByRole('button', { name: /Delete…/ });
    expect((hibernate as HTMLButtonElement).disabled).toBe(true);
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(hibernate.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('agent-run-off').textContent).toBe(
      'Hibernate and Delete are off while a run is working in this agent — cancel the run first.',
    );
  });

  it('an agent with no run shows neither the line nor the reason, and its buttons stay on', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    expect(runLine()).toBeNull();
    expect(screen.queryByTestId('agent-run-off')).toBeNull();
    expect(
      (within(panel()).getByRole('button', { name: /Hibernate/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a run with no known card still links the run', async () => {
    routes.list = () => page([busy({ activeRun: { ...RUN, workItemKey: null, title: null } })]);
    await mount(routes.list(), { openAgentId: 'a1' });
    const line = runLine()!;
    expect(
      within(line)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Open run']);
  });
});

describe('the last run (panel 3)', () => {
  it('a success: the end pill, Last run, the key and the title on the muted ground; the buttons return', async () => {
    routes.list = () => page([agent({ lastRun: lastRun() })]);
    await mount(routes.list(), { openAgentId: 'a1' });
    const line = runLine()!;
    expect(line.getAttribute('data-state')).toBe('ended');
    expect(line.className).toContain('bg-(--el-muted)');
    expect(line.textContent).toContain('Succeeded');
    expect(line.textContent).toContain('Last run');
    expect(line.textContent).toContain('The run section names the agent it ran in');
    expect(within(line).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      '/runs?run=run-1',
    );
    expect(screen.queryByTestId('agent-run-off')).toBeNull();
    expect(
      (within(panel()).getByRole('button', { name: /Hibernate/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a failure shows the RECORDED reason in mono instead of the title', async () => {
    routes.list = () =>
      page([agent({ lastRun: lastRun({ status: 'failed', reason: 'the agent stopped' }) })]);
    await mount(routes.list(), { openAgentId: 'a1' });
    const line = runLine()!;
    expect(line.textContent).toContain('Failed');
    const reason = within(line).getByText('the agent stopped');
    expect(reason.className).toContain('font-mono');
    expect(line.textContent).not.toContain('The run section names the agent it ran in');
  });

  it('a failure with no recorded reason falls back to the title; no card, no key', async () => {
    routes.list = () =>
      page([
        agent({
          lastRun: lastRun({ status: 'timed_out', reason: null, workItemKey: null, title: null }),
        }),
      ]);
    await mount(routes.list(), { openAgentId: 'a1' });
    expect(runLine()!.textContent).toContain('Timed out');
    expect(within(runLine()!).getAllByRole('link')).toHaveLength(1);
  });

  it('the record closing turns the line without a reload — the list re-reads while a run works', async () => {
    vi.useFakeTimers();
    routes.list = () => page([busy()]);
    await mount(routes.list(), { openAgentId: 'a1' });
    expect(runLine()!.getAttribute('data-state')).toBe('live');
    routes.list = () => page([agent({ lastRun: lastRun({ status: 'cancelled' }) })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    await flush();
    expect(runLine()!.getAttribute('data-state')).toBe('ended');
    expect(runLine()!.textContent).toContain('Cancelled');
    // No run anywhere: the list stops polling.
    const reads = calls().filter((c) => c.method === 'GET').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    });
    expect(calls().filter((c) => c.method === 'GET').length).toBe(reads);
  });
});

describe('the run’s session beside your shell (panel 1)', () => {
  it('is offered once the shell’s socket lists it; opening the panel lands on Your shell', async () => {
    routes.list = () => page([busy()]);
    await mount(routes.list(), { openAgentId: 'a1' });
    const shell = await goLive();
    expect(sessionSwitch()).toBeNull();

    act(() => shell.frame({ t: 'sessions', sessions: [SHELL, RUN_SESSION] }));
    await flush();
    const group = sessionSwitch()!;
    const mine = within(group).getByRole('button', { name: 'Your shell' });
    const run = within(group).getByRole('button', { name: /Run MOTIR-1789/ });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(run.getAttribute('aria-pressed')).toBe('false');
    expect(panel().textContent).toContain('The run’s session is watch-only');
    // Offered on the shell's own socket: no second connection yet.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('choosing it attaches the run session through the SAME ticket route, watch-only, and the shell stays', async () => {
    const shell = await openBusyAndList();
    const before = ticketCalls();
    const watch = await watchRun();

    expect(ticketCalls()).toBe(before + 1);
    expect(watch).not.toBe(shell);
    expect(watch.url).toBe(TICKET.url);
    expect(watch.frames[0]).toEqual({ t: 'auth', ticket: 't0k3n' });
    expect(watch.frames[1]).toMatchObject({ t: 'open', session: 'run-sess' });
    // The shell's socket is untouched.
    expect(shell.closedWith).toBeNull();

    // Its replay and output reach the run's own terminal.
    act(() => watch.bytes('motir run MOTIR-1789'));
    const runTerm = xterm.instances[xterm.instances.length - 1]!;
    expect(new TextDecoder().decode(runTerm.written[0]!)).toBe('motir run MOTIR-1789');
    expect(runTerm.resets).toBeGreaterThan(0);
    // No caret, no input: the terminal takes no keys, and none reach the socket.
    expect(runTerm.options['disableStdin']).toBe(true);
    expect(runTerm.options['cursorBlink']).toBe(false);
    expect(runTerm.options['cursorInactiveStyle']).toBe('none');
    const sent = watch.sent.length;
    act(() => runTerm.fireData('rm -rf /'));
    expect(watch.sent.length).toBe(sent);
    // A resize is applied.
    act(() => runTerm.fireResize(100, 30));
    expect(watch.frames[watch.frames.length - 1]).toEqual({ t: 'resize', cols: 100, rows: 30 });

    const strip = screen.getByText(/Watching the run of MOTIR-1789/).closest('[role="status"]')!;
    expect(strip.className).toContain('bg-(--el-tint-sky)');
    expect(
      within(strip as HTMLElement)
        .getByRole('link', { name: 'the work item' })
        .getAttribute('href'),
    ).toBe('/items/MOTIR-1789');
    expect(
      within(sessionSwitch()!)
        .getByRole('button', { name: /Run MOTIR-1789/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('region', { name: 'Run MOTIR-1789' })).toBeTruthy();

    // Back to your shell: the watch closes, the shell was never re-attached.
    const tickets = ticketCalls();
    fireEvent.click(within(sessionSwitch()!).getByRole('button', { name: 'Your shell' }));
    await flush();
    expect(watch.closedWith).toBe(1000);
    expect(shell.closedWith).toBeNull();
    expect(ticketCalls()).toBe(tickets);
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
  });

  it('the watch keeps its heartbeat and ignores the shell’s frames', async () => {
    vi.useFakeTimers();
    await openBusyAndList();
    const watch = await watchRun();
    act(() => watch.frame({ t: 'signin', profile: 'claude', state: 'signed_out' }));
    act(() => watch.frame({ t: 'sessions', sessions: [] }));
    act(() => watch.onmessage?.({ data: 'not json' }));
    act(() => watch.onmessage?.({ data: new Uint8Array([104, 105]) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_PING_MS);
    });
    expect(watch.frames.some((f) => f['t'] === 'ping')).toBe(true);
    expect(screen.queryByTestId('agent-signin')).toBeNull();
  });

  it('a listing the record has not caught up with asks the list to re-read, then offers the run', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const shell = await goLive();
    const reads = calls().filter((c) => c.method === 'GET').length;
    routes.list = () => page([busy(), codex({ state: 'hibernated' })]);
    act(() => shell.frame({ t: 'sessions', sessions: [SHELL, RUN_SESSION] }));
    await flush();
    expect(calls().filter((c) => c.method === 'GET').length).toBe(reads + 1);
    expect(sessionSwitch()).toBeTruthy();
    expect(runLine()!.getAttribute('data-state')).toBe('live');
  });

  it('a listing that drops the run re-reads the list, and the switch goes', async () => {
    const shell = await openBusyAndList();
    routes.list = () => page([agent({ lastRun: lastRun() }), codex({ state: 'hibernated' })]);
    const reads = calls().filter((c) => c.method === 'GET').length;
    act(() => shell.frame({ t: 'sessions', sessions: [SHELL] }));
    await flush();
    expect(calls().filter((c) => c.method === 'GET').length).toBe(reads + 1);
    expect(sessionSwitch()).toBeNull();
    expect(runLine()!.getAttribute('data-state')).toBe('ended');
  });

  it('a malformed session list offers nothing', () => {
    expect(parseSessionListings('x')).toEqual([]);
    expect(
      parseSessionListings([
        null,
        7,
        { kind: 'shell' },
        { session: 's', kind: 'run' },
        { session: 's', kind: 'other' },
        { session: 'a', kind: 'shell' },
        { session: 'b', kind: 'run', runId: 'r' },
      ]),
    ).toEqual([
      { session: 'a', kind: 'shell' },
      { session: 'b', kind: 'run', runId: 'r' },
    ]);
  });
});

describe('the run’s session ends (panel 3)', () => {
  it('while watched: its last screen stays dimmed under the ended strip, the list re-reads, and Back to your shell returns', async () => {
    const shell = await openBusyAndList();
    const watch = await watchRun();
    routes.list = () => page([agent({ lastRun: lastRun() }), codex({ state: 'hibernated' })]);
    const reads = calls().filter((c) => c.method === 'GET').length;
    act(() => watch.frame({ t: 'exit', code: 0, signal: null }));
    act(() => watch.drop(1000));
    await flush();

    expect(calls().filter((c) => c.method === 'GET').length).toBeGreaterThan(reads);
    const strip = screen
      .getByText(
        'The run’s session has ended — the run succeeded, and its pull request is on the work item.',
      )
      .closest('[role="status"]')!;
    expect(strip.className).toContain('bg-(--el-muted)');
    // The switch has gone with the session; the last screen is dimmed.
    expect(sessionSwitch()).toBeNull();
    expect(
      screen.getAllByTestId('agent-terminal').some((el) => el.className.includes('opacity-60')),
    ).toBe(true);
    expect(runLine()!.getAttribute('data-state')).toBe('ended');

    fireEvent.click(
      within(strip as HTMLElement).getByRole('button', { name: 'Back to your shell' }),
    );
    await flush();
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
    expect(shell.closedWith).toBeNull();
  });

  it('a failed run says its work is on the run’s branch; before the record answers, the strip says Ended', async () => {
    vi.useFakeTimers();
    await openBusyAndList();
    const watch = await watchRun();
    // The record has not closed yet when the session goes.
    act(() => watch.frame({ t: 'error', code: 'unknown_session' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Back to your shell' })).toBeTruthy();
    expect(screen.getAllByText('Ended').length).toBeGreaterThan(0);

    // The list's run poll brings the end.
    routes.list = () =>
      page([agent({ lastRun: lastRun({ status: 'failed', reason: 'the agent stopped' }) })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    await flush();
    expect(
      screen.getByText(
        'The run’s session has ended — the run failed. Its work so far is on the run’s branch.',
      ),
    ).toBeTruthy();
    expect(runLine()!.textContent).toContain('the agent stopped');
  });

  it('another tab watching takes it over; Use it here takes it back on a new ticket', async () => {
    await openBusyAndList();
    const watch = await watchRun();
    act(() => watch.frame({ t: 'error', code: 'taken_over' }));
    act(() => watch.drop(1000));
    await flush();
    const tickets = ticketCalls();
    fireEvent.click(screen.getByRole('button', { name: 'Use it here' }));
    await flush();
    expect(ticketCalls()).toBe(tickets + 1);
    const again = lastSocket();
    act(() => again.accept());
    expect(again.frames[1]).toMatchObject({ t: 'open', session: 'run-sess' });
  });
});

describe('the watch’s connection', () => {
  it('a refused ticket hands the reader back their shell', async () => {
    await openBusyAndList();
    routes.ticket = () => json(409, { code: 'not_running' });
    fireEvent.click(within(sessionSwitch()!).getByRole('button', { name: /Run MOTIR-1789/ }));
    await flush();
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
    expect(
      within(sessionSwitch()!)
        .getByRole('button', { name: 'Your shell' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it.each([4403, 4409, 4410])('a %i close hands the reader back their shell', async (code) => {
    await openBusyAndList();
    const watch = await watchRun();
    act(() => watch.drop(code));
    await flush();
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
  });

  it('a stale ticket (4401) retries once silently; a second is the end of the watch', async () => {
    await openBusyAndList();
    const watch = await watchRun();
    const tickets = ticketCalls();
    act(() => watch.drop(4401));
    await flush();
    expect(ticketCalls()).toBe(tickets + 1);
    act(() => lastSocket().drop(4401));
    await flush();
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
  });

  it('a drop reconnects with backoff to the same session, and gives up after the window', async () => {
    vi.useFakeTimers();
    await openBusyAndList();
    const watch = await watchRun();
    act(() => watch.drop(1006));
    await flush();
    // Connecting again: the connecting face covers the run's terminal.
    expect(screen.getByTestId('agent-run-watch').textContent).toContain(
      'Connecting to yue-claude’s terminal…',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    const again = lastSocket();
    expect(again).not.toBe(watch);
    act(() => again.accept());
    expect(again.frames[1]).toMatchObject({ t: 'open', session: 'run-sess' });

    // The server stops answering for the whole window: the watch gives up.
    routes.ticket = () => {
      throw new Error('offline');
    };
    act(() => again.drop(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_RECONNECT_WINDOW_MS + 15_000);
    });
    await flush();
    expect(screen.queryByTestId('agent-run-watch')).toBeNull();
  });

  it('a malformed grant or an unopenable socket retries', async () => {
    vi.useFakeTimers();
    await openBusyAndList();
    routes.ticket = () => json(200, { url: '' });
    fireEvent.click(within(sessionSwitch()!).getByRole('button', { name: /Run MOTIR-1789/ }));
    await flush();
    const tickets = ticketCalls();
    routes.ticket = () => json(200, TICKET);
    const Real = FakeSocket;
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    expect(ticketCalls()).toBe(tickets + 1);
    vi.stubGlobal('WebSocket', Real);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();
    expect(ticketCalls()).toBe(tickets + 2);
    expect(lastSocket().url).toBe(TICKET.url);
  });
});

describe('Hibernate and Delete refused during a run (panel 2)', () => {
  const refusedBody = {
    code: 'agent_instance_run_active',
    runId: 'run-1',
    workItemKey: 'MOTIR-1789',
  };

  it('pressed from a panel that has not polled: the refusal names the run, inside the panel', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    routes.hibernate = () => json(409, refusedBody);
    fireEvent.click(within(panel()).getByRole('button', { name: /Hibernate/ }));
    await flush();
    const alert = within(panel()).getByRole('alert');
    expect(alert.textContent).toBe(
      'yue-claude is running MOTIR-1789. Cancel that run on the work item first, then hibernate it.',
    );
    expect(within(alert).getByRole('link', { name: 'MOTIR-1789' }).getAttribute('href')).toBe(
      '/runs?run=run-1',
    );
  });

  it('pressed from the list’s row menu with no panel open: the page’s refusal box says it', async () => {
    await mount();
    routes.hibernate = () => json(409, { ...refusedBody, workItemKey: null });
    const row = screen.getAllByTestId('agent-row')[0]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for yue-claude' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Hibernate/ }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(
      'yue-claude is running run-1. Cancel that run on the work item first, then hibernate it.',
    );
  });

  it('Delete refused: the confirmation says so, naming the run', async () => {
    await mount();
    routes.del = () => json(409, refusedBody);
    const row = screen.getAllByTestId('agent-row')[0]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for yue-claude' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));
    await flush();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'yue-claude is running MOTIR-1789. Cancel that run on the work item first, then delete it.',
    );
  });
});

describe('the narrow width (panel 4)', () => {
  it('the switch fills the width and drops its hint; Open run takes its own line', async () => {
    await openBusyAndList();
    const group = sessionSwitch()!;
    expect(group.className).toContain('w-full');
    expect(group.className).toContain('@5xl:w-auto');
    expect(screen.getByText('The run’s session is watch-only').className).toContain('hidden');
    expect(within(runLine()!).getByRole('link', { name: 'Open run' }).className).toContain(
      'basis-full',
    );
  });
});

describe('zh', () => {
  it('renders the run line, the switch and the watch strip from the zh catalog', async () => {
    routes.list = () => page([busy()]);
    await mount(routes.list(), { openAgentId: 'a1', messages: zhMessages });
    const shell = await goLive();
    act(() => shell.frame({ t: 'sessions', sessions: [SHELL, RUN_SESSION] }));
    await flush();
    expect(runLine()!.textContent).toContain('正在处理一个工作项');
    expect(runLine()!.textContent).toContain('打开运行');
    const group = within(panel()).getByRole('group', { name: '终端会话' });
    fireEvent.click(within(group).getByRole('button', { name: /运行 MOTIR-1789/ }));
    await flush();
    act(() => lastSocket().accept());
    act(() =>
      lastSocket().frame({
        t: 'ready',
        session: 'run-sess',
        resumed: true,
        kind: 'run',
        runId: 'run-1',
      }),
    );
    await flush();
    expect(panel().textContent).toContain('正在观看 MOTIR-1789 的运行');
  });
});
