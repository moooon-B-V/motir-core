import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../../src/agentTerminal/chat/adapter.js';
import {
  classifyClaudeAuth,
  claudeProjectDir,
  createClaudeChatAdapter,
  createClaudeMapper,
  listClaudeSessions,
  readClaudeHistory,
  runClaudeAuthStatus,
  toolCallEvent,
  toolResultEvent,
} from '../../src/agentTerminal/chat/adapters/claude.js';
import {
  codexChatAdapter,
  createCodexMapper,
  listCodexSessions,
  readCodexHistory,
} from '../../src/agentTerminal/chat/adapters/codex.js';
import {
  createGooseAdapter,
  createGooseMapper,
  gooseTime,
  mapToolCall,
  mapToolResult,
  parseGooseSessionList,
  runGooseSessionList,
  unifiedDiff,
} from '../../src/agentTerminal/chat/adapters/goose.js';
import {
  createKimiMapper,
  kimiAdapter,
  kimiHome,
  parseSessionIndex,
} from '../../src/agentTerminal/chat/adapters/kimi.js';
import {
  createOpencodeAdapter,
  createOpencodeMapper,
  execOpencode,
  parseOpencodeExport,
  parseOpencodeSessionList,
} from '../../src/agentTerminal/chat/adapters/opencode.js';
import type { TranscriptEvent } from '../../src/agentTerminal/chat/protocol.js';

// THE CHAT STORY GATE's edges, the in-agent half (Story MOTIR-6863 · MOTIR-7018).
//
// Each adapter card tested its fixtures: the streams its CLI really writes, and
// the store it really keeps. What those fixtures never carry is the malformed,
// the partial and the absent — a tool call with no input, a result with no id,
// a store line that is not JSON, a helper binary that exits non-zero or cannot
// start. Every one of those is a branch the adapter DECIDES, and a branch the
// adapter decides is a place the transcript can go wrong, so each is driven here
// once and its answer pinned: dropped, defaulted, or named `other`, and never a
// throw.
//
// The three HELPERS that run a vendor binary (`claude auth status`, `goose
// session list`, `opencode session list|export`) are run for real, against a
// stand-in script on a PATH this file controls — never the machine's own
// binaries, which is why every PATH here starts and ends inside a temp dir.

const temps: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A PATH holding exactly one stand-in binary, a `#!/bin/sh` script of builtins. */
async function fakeBinary(name: string, body: string): Promise<{ dir: string; ctx: ChatContext }> {
  const dir = await temp(`motir-chat-bin-${name}-`);
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return {
    dir,
    ctx: { home: dir, cwd: dir, env: { HOME: dir, PATH: dir, MOTIR_TERMINAL_KEY: 'k' } },
  };
}

const lines = (mapper: { onLine(line: string): TranscriptEvent[] }, ...values: unknown[]) =>
  values.flatMap((value) =>
    mapper.onLine(typeof value === 'string' ? value : JSON.stringify(value)),
  );

// ── Claude Code ─────────────────────────────────────────────────────────────

describe('claude — the gate’s probe, run for real against a stand-in binary', () => {
  it('resolves the answer, whatever the exit code, and never passes the key', async () => {
    const { ctx } = await fakeBinary(
      'claude',
      'printf \'{"loggedIn":false,"key":"%s","args":"%s"}\' "${MOTIR_TERMINAL_KEY:-absent}" "$*"\nexit 1',
    );
    const answer = await runClaudeAuthStatus(ctx);
    expect(JSON.parse(answer)).toEqual({
      loggedIn: false,
      key: 'absent',
      args: 'auth status --json',
    });
  });

  it('rejects when the binary says nothing — with its error, or a plain one on exit 0', async () => {
    const failing = await fakeBinary('claude', 'exit 3');
    await expect(runClaudeAuthStatus(failing.ctx)).rejects.toBeInstanceOf(Error);
    const silent = await fakeBinary('claude', 'exit 0');
    await expect(runClaudeAuthStatus(silent.ctx)).rejects.toThrow('no answer');
  });

  it('an answer that is not an auth status is not a yes', async () => {
    for (const answer of ['no json here', '} backwards {', '{not json}']) {
      const adapter = createClaudeChatAdapter({ probe: async () => answer });
      expect(await adapter.support({ home: '/h', cwd: '/h', env: {} })).toEqual({
        supported: false,
        code: 'unsupported',
      });
    }
  });

  it('classifies a non-string provider or source as the subscription', () => {
    expect(classifyClaudeAuth({ apiProvider: 7 as never, apiKeySource: 3 as never })).toBe(
      'subscription',
    );
    expect(classifyClaudeAuth({ apiProvider: '', apiKeySource: '' })).toBe('subscription');
    expect(classifyClaudeAuth({ apiProvider: 'bedrock' })).toBe('cloud_provider');
  });
});

describe('claude — a tool_use or tool_result block missing its parts', () => {
  it('drops a block with no id or no name, and reads a missing input as empty', () => {
    expect(toolCallEvent({ name: 'Bash' })).toBeNull();
    expect(toolCallEvent({ id: 't' })).toBeNull();
    expect(toolCallEvent({ id: 't1', name: 'Read', input: 'not an object' })).toEqual({
      k: 'tool_call',
      id: 't1',
      kind: 'read',
      name: 'Read',
      title: 'Read',
    });
  });

  it('an edit with no path is titled by its tool and carries no diff; a partial input carries none either', () => {
    expect(toolCallEvent({ id: 'e1', name: 'Edit', input: {} })).toEqual({
      k: 'tool_call',
      id: 'e1',
      kind: 'edit',
      name: 'Edit',
      title: 'Edit',
    });
    const partial = [
      { id: 'e2', name: 'Edit', input: { file_path: '/w/a', old_string: 'x' } },
      { id: 'e3', name: 'MultiEdit', input: { file_path: '/w/a', edits: 'not a list' } },
      {
        id: 'e4',
        name: 'MultiEdit',
        input: { file_path: '/w/a', edits: ['not an object', { old_string: 'only old' }] },
      },
      { id: 'e5', name: 'Write', input: { file_path: '/w/a' } },
    ];
    for (const block of partial) {
      const call = toolCallEvent(block);
      expect(call).toMatchObject({ kind: 'edit', path: '/w/a', title: '/w/a' });
      expect(call).not.toHaveProperty('diff');
    }
    // A MultiEdit keeps its valid edits and skips the rest.
    expect(
      toolCallEvent({
        id: 'e6',
        name: 'MultiEdit',
        input: { file_path: '/w/a', edits: [7, { old_string: 'a\n', new_string: '' }] },
      }),
    ).toMatchObject({ diff: '--- a/w/a\n+++ b/w/a\n@@ -1 +0 @@\n-a\n' });
  });

  it('a Bash call is titled by its description, else its command, else its name', () => {
    expect(toolCallEvent({ id: 'b1', name: 'Bash', input: { command: 'ls' } })).toMatchObject({
      title: 'ls',
      command: 'ls',
    });
    const bare = toolCallEvent({ id: 'b2', name: 'Bash', input: {} });
    expect(bare).toEqual({
      k: 'tool_call',
      id: 'b2',
      kind: 'command',
      name: 'Bash',
      title: 'Bash',
    });
  });

  it('a result with no id is dropped; content that is not text is empty; image parts are not text', () => {
    expect(toolResultEvent({ content: 'x' })).toBeNull();
    expect(toolResultEvent({ tool_use_id: 'r1', content: 42 })).toEqual({
      k: 'tool_result',
      id: 'r1',
      ok: true,
      output: '',
      truncated: false,
    });
    expect(
      toolResultEvent({
        tool_use_id: 'r2',
        is_error: true,
        content: [{ type: 'image' }, 'bare', { type: 'text', text: 'denied' }],
      }),
    ).toEqual({ k: 'tool_result', id: 'r2', ok: false, output: 'denied', truncated: false });
  });
});

describe('claude — the stream mapper on lines no fixture carries', () => {
  it('drops what is not an object, has no type, or belongs to no message', () => {
    const m = createClaudeMapper();
    expect(
      lines(
        m,
        '[1,2]',
        { no: 'type' },
        { type: 'stream_event' },
        { type: 'stream_event', event: { type: 'message_start' } },
        { type: 'stream_event', event: { type: 'message_start', message: {} } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: 'x' } },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'orphan' } },
        },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'assistant' },
        { type: 'assistant', message: { content: 'not a list' } },
        { type: 'user' },
        { type: 'user', message: { content: [{ type: 'text', text: 'not a result' }, 'x'] } },
        { type: 'rate_limit_event' },
        { type: 'keep_alive' },
      ),
    ).toEqual([]);
  });

  it('a delta with no index is index 0; an empty delta is dropped', () => {
    const m = createClaudeMapper();
    expect(
      lines(
        m,
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'text_delta', text: '!' },
          },
        },
      ),
    ).toEqual([
      { k: 'text', id: 'm1:0', delta: 'Hi' },
      { k: 'text', id: 'm1:2', delta: '!' },
    ]);
  });

  it('a complete message not streamed is drawn whole, keyed by its id, its uuid, or "message"; a repeat call or result is drawn once', () => {
    const m = createClaudeMapper();
    const call = { type: 'tool_use', id: 'tu1', name: 'Glob', input: {} };
    expect(
      lines(
        m,
        {
          type: 'assistant',
          message: {
            id: 'm2',
            content: [{ type: 'text', text: 'Whole.' }, 'x', { type: 'text', text: '' }, call],
          },
        },
        {
          type: 'assistant',
          uuid: 'u3',
          message: { content: [{ type: 'text', text: 'By uuid.' }, call, { type: 'tool_use' }] },
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Anonymous.' }] } },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
              { type: 'tool_result' },
            ],
          },
        },
      ),
    ).toEqual([
      { k: 'text', id: 'm2:t0', delta: 'Whole.' },
      { k: 'tool_call', id: 'tu1', kind: 'other', name: 'Glob', title: 'Glob' },
      { k: 'text', id: 'u3:t0', delta: 'By uuid.' },
      { k: 'text', id: 'message:t0', delta: 'Anonymous.' },
      { k: 'tool_result', id: 'tu1', ok: true, output: 'ok', truncated: false },
    ]);
  });

  it('a result with no subtype is an `error`; with no message it carries none; system lines are named or dropped', () => {
    const m = createClaudeMapper();
    expect(
      lines(
        m,
        { type: 'result', is_error: true },
        { type: 'system', subtype: 'api_retry' },
        { type: 'system', subtype: 'hook_started' },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'system' },
        { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' },
      ),
    ).toEqual([
      { k: 'error', code: 'error' },
      { k: 'error', code: 'api_retry' },
      { k: 'other', name: 'system/compact_boundary' },
      { k: 'other', name: 'system' },
    ]);
    expect(m.sawEnd()).toBe(true);
    expect(m.killCode()).toBeNull();
  });
});

describe('claude — the store, on files no fixture carries', () => {
  async function store(): Promise<{ ctx: ChatContext; dir: string }> {
    const home = await temp('motir-chat-claude-edges-');
    const ctx: ChatContext = { home, cwd: join(home, 'workspace'), env: { HOME: home } };
    const dir = claudeProjectDir(ctx);
    await mkdir(dir, { recursive: true });
    return { ctx, dir };
  }
  const row = (value: unknown) => `${JSON.stringify(value)}\n`;

  it('lists past a bad name, a directory, a torn line and every entry that is no prompt', async () => {
    const { ctx, dir } = await store();
    await writeFile(join(dir, '-bad.jsonl'), row({ type: 'user', message: { content: 'x' } }));
    await mkdir(join(dir, 'aaaaaaaa-0000-4000-8000-00000000000a.jsonl'));
    const id = 'bbbbbbbb-0000-4000-8000-00000000000b';
    await writeFile(
      join(dir, `${id}.jsonl`),
      [
        '{torn',
        row({ type: 'user' }),
        row({ type: 'user', message: { content: 7 } }),
        row({ type: 'user', message: { content: '   ' } }),
        row({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
        row({ type: 'user', message: { content: [{ type: 'text', text: 'From parts.' }] } }),
      ].join(''),
    );
    expect(await listClaudeSessions(ctx, 50)).toEqual([
      expect.objectContaining({ id, title: 'From parts.' }),
    ]);
  });

  it('reads only the head of a long session for its title, cutting at a whole line', async () => {
    const { ctx, dir } = await store();
    const id = 'cccccccc-0000-4000-8000-00000000000c';
    const filler = row({ type: 'summary-less', pad: 'p'.repeat(1024) });
    await writeFile(
      join(dir, `${id}.jsonl`),
      row({ type: 'user', message: { content: 'First.' } }) + filler.repeat(100),
    );
    expect(await listClaudeSessions(ctx, 50)).toEqual([
      expect.objectContaining({ id, title: 'First.' }),
    ]);
    // Two files tied on mtime sort by id.
    const tied = 'cccccccc-0000-4000-8000-00000000000b';
    await writeFile(
      join(dir, `${tied}.jsonl`),
      row({ type: 'user', message: { content: 'Tie.' } }),
    );
    const at = new Date('2026-09-01T00:00:00Z');
    await utimes(join(dir, `${id}.jsonl`), at, at);
    await utimes(join(dir, `${tied}.jsonl`), at, at);
    expect((await listClaudeSessions(ctx, 50)).map((s) => s.id)).toEqual([tied, id]);
  });

  it('history skips what it cannot draw, and draws each call once', async () => {
    const { ctx, dir } = await store();
    const id = 'dddddddd-0000-4000-8000-00000000000d';
    const call = { type: 'tool_use', id: 'h1', name: 'Bash', input: { command: 'ls' } };
    await writeFile(
      join(dir, `${id}.jsonl`),
      [
        row({ type: 'user', message: { content: 'Go.' } }),
        row({
          type: 'assistant',
          isSidechain: true,
          message: { content: [{ type: 'text', text: 'side' }] },
        }),
        row({ type: 'assistant', message: 'no content' }),
        row({
          type: 'assistant',
          uuid: 'u1',
          message: { content: ['x', { type: 'text', text: 'By uuid.' }, call] },
        }),
        row({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Anon.' }, call, { type: 'thinking' }] },
        }),
        row({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta' }] } }),
        row({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', content: 'no id' },
              { type: 'tool_result', tool_use_id: 'h1', content: 'a.txt' },
            ],
          },
        }),
        row({ type: 'system', message: { content: [{ type: 'text', text: 'system' }] } }),
      ].join(''),
    );
    expect(await readClaudeHistory(ctx, id, 1024 * 1024)).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'Go.' },
        { k: 'text', id: 'u1:h1', delta: 'By uuid.' },
        { k: 'tool_call', id: 'h1', kind: 'command', name: 'Bash', title: 'ls', command: 'ls' },
        { k: 'text', id: 'message:h0', delta: 'Anon.' },
        { k: 'tool_result', id: 'h1', ok: true, output: 'a.txt', truncated: false },
      ],
    });
  });

  it('a session larger than the scan is read from its newest part, from its first whole turn', async () => {
    const { ctx, dir } = await store();
    const pad = row({
      type: 'assistant',
      message: { id: 'old', content: [{ type: 'text', text: 'o'.repeat(64 * 1024) }] },
    });
    const long = 'eeeeeeee-0000-4000-8000-00000000000e';
    await writeFile(
      join(dir, `${long}.jsonl`),
      pad.repeat(140) + row({ type: 'user', message: { content: 'Newest.' } }),
    );
    expect(await readClaudeHistory(ctx, long, 1024 * 1024)).toEqual({
      truncated: true,
      events: [{ k: 'user', text: 'Newest.' }],
    });
    // Cut, with no whole turn left in the part read: nothing is drawn.
    const headless = 'ffffffff-0000-4000-8000-00000000000f';
    await writeFile(join(dir, `${headless}.jsonl`), pad.repeat(140));
    expect(await readClaudeHistory(ctx, headless, 1024 * 1024)).toEqual({
      truncated: true,
      events: [],
    });
  });
});

// ── Codex ───────────────────────────────────────────────────────────────────

describe('codex — the mapper on items no fixture carries', () => {
  const item = (type: string, value: Record<string, unknown>) => ({ type, item: value });

  it('drops a started item it does not draw, and a re-announced start', () => {
    const m = createCodexMapper();
    expect(
      lines(
        m,
        item('item.started', { id: 'i1', type: 'agent_message' }),
        item('item.started', { id: 'i2', type: 'command_execution' }),
        item('item.started', { id: 'i2', type: 'command_execution' }),
        item('item.started', { id: 'i3', type: 'mcp_tool_call' }),
        item('item.started', { id: 'i4', type: 'web_search' }),
      ),
    ).toEqual([
      {
        k: 'tool_call',
        id: 'i2',
        kind: 'command',
        name: 'command_execution',
        title: '',
        command: '',
      },
      { k: 'tool_call', id: 'i3', kind: 'other', name: 'mcp_tool_call', title: 'mcp_tool_call' },
      { k: 'tool_call', id: 'i4', kind: 'other', name: 'web_search', title: 'web_search' },
    ]);
  });

  it('completes items with their parts absent: no exit code, no changes list, no kind, no MCP text', () => {
    const m = createCodexMapper();
    expect(
      lines(
        m,
        item('item.completed', { id: 'a', type: 'agent_message' }),
        item('item.completed', { id: 'c', type: 'command_execution', command: 'true' }),
        item('item.completed', { id: 'f', type: 'file_change', changes: 'nope' }),
        item('item.completed', { id: 'g', type: 'file_change', changes: [{ path: 'x.md' }, {}] }),
        item('item.completed', { id: 'm1', type: 'mcp_tool_call', result: 'not an object' }),
        item('item.completed', {
          id: 'm2',
          type: 'mcp_tool_call',
          server: 's',
          tool: 't',
          result: { content: [{ type: 'image' }] },
        }),
        item('item.completed', { id: 'e', type: 'error' }),
        item('item.completed', { id: 'n' }),
      ),
    ).toEqual([
      {
        k: 'tool_call',
        id: 'c',
        kind: 'command',
        name: 'command_execution',
        title: 'true',
        command: 'true',
      },
      { k: 'tool_result', id: 'c', ok: true, output: '', truncated: false },
      {
        k: 'tool_call',
        id: 'g:0',
        kind: 'edit',
        name: 'file_change',
        title: 'update x.md',
        path: 'x.md',
      },
      { k: 'tool_result', id: 'g:0', ok: true, truncated: false },
      { k: 'tool_call', id: 'm1', kind: 'other', name: 'mcp_tool_call', title: 'mcp_tool_call' },
      { k: 'tool_result', id: 'm1', ok: true, truncated: false },
      { k: 'tool_call', id: 'm2', kind: 'other', name: 's.t', title: 's.t' },
      { k: 'tool_result', id: 'm2', ok: true, truncated: false },
      { k: 'error', code: 'codex_error' },
    ]);
  });

  it('thread, failure and error lines with their fields absent', () => {
    const m = createCodexMapper();
    expect(
      lines(
        m,
        { type: 'thread.started' },
        { type: 'turn.failed' },
        { type: 'error' },
        '"a string"',
        { type: 7 },
      ),
    ).toEqual([
      { k: 'error', code: 'turn_failed' },
      { k: 'error', code: 'codex_error' },
    ]);
    expect(m.sessionId()).toBeNull();
    expect(codexChatAdapter.createMapper().killCode()).toBeNull();
  });
});

describe('codex — the rollout store, on files no fixture carries', () => {
  async function home(): Promise<ChatContext> {
    const dir = await temp('motir-chat-codex-edges-');
    return { home: dir, cwd: '/w', env: { HOME: dir, CODEX_HOME: join(dir, 'codex') } };
  }
  const THREAD = '01a0f1f0-0000-7000-8000-000000000001';
  const rollout = async (ctx: ChatContext, rel: string, rows: unknown[], mtime?: Date) => {
    const path = join(ctx.env['CODEX_HOME']!, 'sessions', rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'),
    );
    if (mtime) await utimes(path, mtime, mtime);
    return path;
  };
  const meta = (id: string | undefined, cwd?: string) => ({
    type: 'session_meta',
    payload: { ...(id ? { id } : {}), ...(cwd ? { cwd } : {}) },
  });
  const said = (message?: string) => ({
    type: 'event_msg',
    payload: { type: 'user_message', ...(message !== undefined ? { message } : {}) },
  });

  it('lists past a meta with no id or cwd, a rollout nested too deep, and titles an unprompted one by its id', async () => {
    const ctx = await home();
    await rollout(ctx, `2026/09/30/rollout-x-${THREAD}.jsonl`, [meta(THREAD, '/w'), said()]);
    await rollout(ctx, '2026/09/30/rollout-x-noid.jsonl', [meta(undefined, '/w'), said('hi')]);
    await rollout(ctx, '2026/09/30/rollout-x-nocwd.jsonl', [meta('nocwd'), said('hi')]);
    await rollout(ctx, 'a/b/c/d/e/rollout-x-deep.jsonl', [meta('deep', '/w'), said('deep')]);
    expect(await listCodexSessions(ctx, 50)).toEqual([
      expect.objectContaining({ id: THREAD, title: THREAD }),
    ]);
  });

  it('history: the newest matching rollout, turns from what the rollout carries and nothing else', async () => {
    const ctx = await home();
    const older = new Date('2026-09-01T00:00:00Z');
    await rollout(ctx, `2026/09/01/rollout-a-${THREAD}.jsonl`, [meta(THREAD, '/elsewhere')], older);
    const call = (payload: Record<string, unknown>) => ({ type: 'response_item', payload });
    await rollout(ctx, `2026/09/30/rollout-b-${THREAD}.jsonl`, [
      meta(THREAD, '/w'),
      { type: 'response_item' },
      call({ type: 'function_call', call_id: 'early' }),
      said(),
      { type: 'event_msg', payload: { type: 'agent_message' } },
      call({ type: 'function_call' }),
      call({ type: 'function_call', call_id: 'f1', arguments: '{"command":"ls -la"}' }),
      call({ type: 'function_call', call_id: 'f2', arguments: '{"cmd":["git",7]}' }),
      call({ type: 'function_call', call_id: 'f3' }),
      call({
        type: 'custom_tool_call',
        call_id: 'p1',
        name: 'apply_patch',
        input: '*** Begin Patch\n+x',
      }),
      call({ type: 'custom_tool_call', call_id: 'p2' }),
      call({
        type: 'function_call_output',
        call_id: 'f1',
        output: { content: 'Exit code: 2\nboom' },
      }),
      call({ type: 'function_call_output', call_id: 'f2', output: 42 }),
      call({
        type: 'function_call_output',
        call_id: 'f3',
        output: '{"output":"wrapped","metadata":{"exit_code":0}}',
      }),
      call({ type: 'reasoning', call_id: 'r1' }),
    ]);
    expect(await readCodexHistory(ctx, THREAD, 1024 * 1024)).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: '' },
        {
          k: 'tool_call',
          id: 'f1',
          kind: 'command',
          name: 'function_call',
          title: 'ls -la',
          command: 'ls -la',
        },
        { k: 'tool_call', id: 'f2', kind: 'other', name: 'function_call', title: 'function_call' },
        { k: 'tool_call', id: 'f3', kind: 'other', name: 'function_call', title: 'function_call' },
        {
          k: 'tool_call',
          id: 'p1',
          kind: 'edit',
          name: 'apply_patch',
          title: 'apply_patch',
          diff: '*** Begin Patch\n+x',
        },
        {
          k: 'tool_call',
          id: 'p2',
          kind: 'other',
          name: 'custom_tool_call',
          title: 'custom_tool_call',
        },
        {
          k: 'tool_result',
          id: 'f1',
          ok: false,
          output: 'Exit code: 2\nboom',
          exitCode: 2,
          truncated: false,
        },
        { k: 'tool_result', id: 'f2', ok: true, truncated: false },
        { k: 'tool_result', id: 'f3', ok: true, output: 'wrapped', exitCode: 0, truncated: false },
        { k: 'turn_end', reason: 'completed' },
      ],
    });
  });

  it('an unknown thread is unavailable', async () => {
    const ctx = await home();
    expect(await readCodexHistory(ctx, THREAD, 1024)).toEqual({ unavailable: true });
  });
});

// ── goose ───────────────────────────────────────────────────────────────────

describe('goose — tool calls and results with their parts absent', () => {
  it('a command with no command is titled by its tool; a text_editor with no command is `other`', () => {
    expect(mapToolCall('c', 'developer__shell', {})).toEqual({
      k: 'tool_call',
      id: 'c',
      kind: 'command',
      name: 'shell',
      title: 'shell',
      command: '',
    });
    expect(mapToolCall('t', 'text_editor', { path: '/w/a' })).toEqual({
      k: 'tool_call',
      id: 't',
      kind: 'other',
      name: 'text_editor',
      title: '/w/a',
    });
  });

  it('each edit operation draws its diff from what its arguments carry, or none', () => {
    const diffOf = (args: Record<string, unknown>) =>
      (mapToolCall('e', 'text_editor', { path: 'a', ...args }) as { diff?: string }).diff;
    expect(diffOf({ command: 'write' })).toBeUndefined();
    expect(diffOf({ command: 'insert' })).toBeUndefined();
    expect(diffOf({ command: 'insert', new_str: 'x\n' })).toBe(unifiedDiff('a', '', 'x\n'));
    expect(diffOf({ command: 'str_replace', old_str: 'x' })).toBeUndefined();
    expect(diffOf({ command: 'edit', content: 'whole' })).toBe(unifiedDiff('a', null, 'whole'));
    expect(mapToolCall('u', 'text_editor', { command: 'undo_edit' })).toMatchObject({
      kind: 'edit',
      title: 'text_editor',
    });
    expect(unifiedDiff('a', null, '')).toBe('--- /dev/null\n+++ a\n@@ -0,0 +0,0 @@\n');
  });

  it('results: a failure with no reason, a structured one without output, and plain content', () => {
    expect(mapToolResult('r', null)).toEqual({
      k: 'tool_result',
      id: 'r',
      ok: false,
      truncated: false,
    });
    expect(mapToolResult('r', { status: 'error' })).toEqual({
      k: 'tool_result',
      id: 'r',
      ok: false,
      truncated: false,
    });
    expect(mapToolResult('r', { status: 'success' })).toEqual({
      k: 'tool_result',
      id: 'r',
      ok: true,
      truncated: false,
    });
    expect(
      mapToolResult('r', {
        status: 'success',
        value: {
          structuredContent: { exitCode: 1.5 },
          content: [{ type: 'text' }, 'x', { type: 'image' }],
        },
      }),
    ).toEqual({ k: 'tool_result', id: 'r', ok: true, output: '', truncated: false });
    expect(
      mapToolResult('r', {
        status: 'success',
        value: { structuredContent: { stderr: 'bad', exit_code: 2 }, isError: false },
      }),
    ).toEqual({
      k: 'tool_result',
      id: 'r',
      ok: false,
      output: 'bad',
      exitCode: 2,
      truncated: false,
    });
    expect(mapToolResult('r', { status: 'success', value: { content: [] } })).toEqual({
      k: 'tool_result',
      id: 'r',
      ok: true,
      truncated: false,
    });
  });
});

describe('goose — the stream mapper on lines no fixture carries', () => {
  it('drops what it cannot draw, names what nobody mapped, and ids text and tools it was not given ids for', () => {
    const m = createGooseMapper();
    const message = (value: Record<string, unknown>) => ({ type: 'message', message: value });
    expect(
      lines(
        m,
        '[]',
        { sessionId: '../bad' },
        { type: 'message' },
        message({ role: 'assistant', content: 'not a list' }),
        message({ role: 'assistant', content: ['x', {}, { type: 'thinking' }, { type: 'text' }] }),
        message({ role: 'user', content: [{ type: 'text', text: 'echoed prompt' }] }),
        message({ role: 'assistant', content: [{ type: 'text', text: 'One ' }] }),
        message({ role: 'assistant', content: [{ type: 'text', text: 'piece.' }] }),
        message({
          role: 'assistant',
          content: [{ type: 'toolRequest', toolCall: { status: 'error' } }],
        }),
        message({
          role: 'assistant',
          content: [
            { type: 'toolRequest', toolCall: { status: 'success', value: { name: 'shell' } } },
          ],
        }),
        message({ role: 'user', content: [{ type: 'toolResponse' }] }),
        message({ role: 'assistant', content: [{ type: 'image' }] }),
        { type: 'error' },
        { type: 'notification' },
        { type: 'x'.repeat(80) },
      ),
    ).toEqual([
      { k: 'text', id: 'goose-text-1', delta: 'One ' },
      { k: 'text', id: 'goose-text-1', delta: 'piece.' },
      { k: 'tool_call', id: 'goose-tool-2', kind: 'other', name: 'tool', title: 'tool' },
      {
        k: 'tool_call',
        id: 'goose-tool-3',
        kind: 'command',
        name: 'shell',
        title: 'shell',
        command: '',
      },
      { k: 'tool_result', id: '', ok: false, truncated: false },
      { k: 'other', name: 'image' },
      { k: 'error', code: 'goose_error' },
      { k: 'other', name: 'x'.repeat(64) },
    ]);
    expect(m.sessionId()).toBeNull();
    expect(m.killCode()).toBeNull();
  });
});

describe('goose — the session list', () => {
  it('runs `goose session list --format json` for real, and refuses a failed run', async () => {
    const ok = await fakeBinary('goose', 'printf \'[{"args":"%s"}]\' "$*"');
    expect(JSON.parse(await runGooseSessionList(ok.ctx))).toEqual([
      { args: 'session list --format json' },
    ]);
    const failed = await fakeBinary('goose', 'exit 1');
    await expect(runGooseSessionList(failed.ctx)).rejects.toThrow('goose session list failed');
    const adapter = createGooseAdapter();
    expect(await adapter.listSessions(ok.ctx, 50)).toEqual([]);
  });

  it('reads every spelling of a row, and skips a row it cannot place', () => {
    const cwd = '/w';
    const rows = {
      sessions: [
        'not a row',
        { id: '../x', working_dir: cwd, updated_at: 1 },
        {
          id: 'a',
          metadata: { working_dir: '/w/', description: 'From metadata' },
          created_at: '2026-09-01 10:00:00',
        },
        { id: 'b', workingDir: cwd, updatedAt: 1_790_000_000_000, name: '  ' },
        { id: 'c', working_dir: cwd, modified: 'not a time' },
        { id: 'd', working_dir: cwd, createdAt: '2026-09-02T10:00' },
        { id: 'e', working_dir: '/elsewhere', updated_at: 1 },
      ],
    };
    expect(parseGooseSessionList(JSON.stringify(rows), cwd, -1)).toEqual([]);
    expect(parseGooseSessionList(JSON.stringify(rows), cwd, 50)).toEqual([
      { id: 'b', title: 'b', updatedAt: new Date(1_790_000_000_000).toISOString() },
      { id: 'd', title: 'd', updatedAt: '2026-09-02T10:00:00.000Z' },
      { id: 'a', title: 'From metadata', updatedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    expect(parseGooseSessionList('{"sessions":"no"}', cwd, 50)).toEqual([]);
    expect(gooseTime(Number.NaN)).toBeNull();
    expect(gooseTime('   ')).toBeNull();
    expect(gooseTime('2026-09-01 10:00:00 UTC')).toBe('2026-09-01T10:00:00.000Z');
  });
});

// ── kimi ────────────────────────────────────────────────────────────────────

describe('kimi — the mapper on lines no fixture carries', () => {
  const call = (id: string | undefined, name: string | undefined, args?: unknown) => ({
    ...(id ? { id } : {}),
    type: 'function',
    function: { ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) },
  });

  it('tool calls: missing parts dropped, arguments as an object, as bad JSON, as JSON that is not an object', () => {
    const m = createKimiMapper();
    expect(
      lines(m, {
        role: 'assistant',
        content: [
          'part ',
          { type: 'text' },
          { type: 'think', think: 'x' },
          { type: 'text', text: 'two' },
        ],
        tool_calls: [
          'x',
          call(undefined, 'Bash'),
          call('n', undefined),
          { id: 'f', function: 'x' },
          call('c1', 'Bash', { command: 'ls' }),
          call('c2', 'Bash', '{bad'),
          call('c3', 'ReadFile', '[1]'),
          call('c4', 'ReadFile', 7),
          call('c5', 'Glob', { path: '/w' }),
          call('c6', 'Glob'),
        ],
      }),
    ).toEqual([
      { k: 'text', id: 'kimi-msg-1', delta: 'part two' },
      { k: 'tool_call', id: 'c1', kind: 'command', name: 'Bash', title: 'ls', command: 'ls' },
      { k: 'tool_call', id: 'c2', kind: 'command', name: 'Bash', title: 'Bash', command: '' },
      { k: 'tool_call', id: 'c3', kind: 'read', name: 'ReadFile', title: 'ReadFile' },
      { k: 'tool_call', id: 'c4', kind: 'read', name: 'ReadFile', title: 'ReadFile' },
      { k: 'tool_call', id: 'c5', kind: 'other', name: 'Glob', title: 'Glob', path: '/w' },
      { k: 'tool_call', id: 'c6', kind: 'other', name: 'Glob', title: 'Glob' },
    ]);
  });

  it('edits: a list of edits, one edit object, a whole-file write, and nothing to draw', () => {
    const m = createKimiMapper();
    const [list, single, whole, none, pathless] = lines(m, {
      role: 'assistant',
      content: 7,
      tool_calls: [
        call('e1', 'StrReplaceFile', {
          path: 'a',
          edit: [{ old: 'x', new: 'y' }, 'skip', { old: 'z' }],
        }),
        call('e2', 'StrReplaceFile', { path: 'a', edits: { old_str: 'x\n', new_str: '' } }),
        call('e3', 'WriteFile', { path: 'a', content: '' }),
        call('e4', 'WriteFile', { path: 'a' }),
        call('e5', 'WriteFile', { content: 'x' }),
      ],
    }) as Array<Record<string, unknown>>;
    expect(list!['diff']).toBe('--- a/a\n+++ b/a\n@@ @@\n-x\n+y\n');
    expect(single!['diff']).toBe('--- a/a\n+++ b/a\n@@ @@\n-x\n');
    expect(whole!['diff']).toBe('--- a/a\n+++ b/a\n@@ @@\n');
    expect(none).not.toHaveProperty('diff');
    expect(pathless).toMatchObject({
      title: 'WriteFile',
      diff: '--- a/file\n+++ b/file\n@@ @@\n+x\n',
    });
    expect(pathless).not.toHaveProperty('path');
  });

  it('tool results, meta and other roles with their fields absent', () => {
    const m = createKimiMapper();
    expect(
      lines(
        m,
        '"a string"',
        { role: 'tool' },
        { role: 'tool', type: 'tool.result' },
        { role: 'tool', tool_call_id: 't1', content: 'out<system>note</system>', is_error: true },
        { role: 'tool', tool_call_id: 't2', content: '<system>ERROR: exit code 3</system>' },
        { role: 'tool', tool_call_id: 't3', content: '<system>all fine</system>' },
        { role: 'meta' },
        { role: 'meta', type: 'session.compact' },
        { role: 'meta', type: 'session.resume_hint' },
        { role: 'user', content: 'echo' },
        { role: 'narrator' },
        { role: 'narrator', type: 'x.y' },
      ),
    ).toEqual([
      { k: 'other', name: 'tool.result' },
      { k: 'tool_result', id: 't1', ok: false, output: 'out', truncated: false },
      {
        k: 'tool_result',
        id: 't2',
        ok: false,
        output: 'ERROR: exit code 3',
        exitCode: 3,
        truncated: false,
      },
      { k: 'tool_result', id: 't3', ok: true, truncated: false },
      { k: 'other', name: 'session.compact' },
      { k: 'other', name: 'x.y' },
    ]);
    expect(m.sawEnd()).toBe(true);
    expect(m.sessionId()).toBeNull();
    expect(m.killCode()).toBeNull();
  });
});

describe('kimi — the session index', () => {
  it('reads every spelling of a time, keeps the latest row per id, and skips what it cannot place', () => {
    const cwd = '/w';
    const text = [
      '',
      '{torn',
      '[1]',
      JSON.stringify({ id: 's-noscope' }),
      JSON.stringify({ session_id: 's1', cwd, updated: '1790000000' }),
      JSON.stringify({ session_id: 's1', cwd, updated: 1_780_000_000, title: 'older' }),
      JSON.stringify({
        session_id: 's2',
        workdir: cwd,
        last_updated: '2026-09-01T00:00:00Z',
        first_prompt: 'p',
      }),
      JSON.stringify({ session_id: 's3', working_directory: cwd, created_at: 'never' }),
      JSON.stringify({ session_id: 's4', path: cwd, created_at: '' }),
      JSON.stringify({
        session_id: 's5',
        work_dir: cwd,
        updated_at: 1_700_000_000_000,
        summary: 'x'.repeat(200),
      }),
    ].join('\n');
    expect(parseSessionIndex(text, cwd, -1)).toEqual([]);
    expect(parseSessionIndex(text, cwd, 50)).toEqual([
      { id: 's1', title: 's1', updatedAt: new Date(1_790_000_000_000).toISOString() },
      { id: 's2', title: 'p', updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 's5', title: 'x'.repeat(120), updatedAt: new Date(1_700_000_000_000).toISOString() },
    ]);
  });

  it('lists from the first index found, and nothing when there is none', async () => {
    const dir = await temp('motir-chat-kimi-edges-');
    const ctx: ChatContext = { home: dir, cwd: '/w', env: { KIMI_CODE_HOME: '  ' } };
    expect(kimiHome(ctx)).toBe(join(dir, '.kimi-code'));
    expect(await kimiAdapter.listSessions(ctx, 50)).toEqual([]);
    await mkdir(join(dir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(dir, '.kimi-code', 'session_index.jsonl'),
      JSON.stringify({ session_id: 'k1', cwd: '/w', updated_at: 1_790_000_000 }),
    );
    expect(await kimiAdapter.listSessions(ctx, 50)).toEqual([
      expect.objectContaining({ id: 'k1' }),
    ]);
    expect(await kimiAdapter.readHistory(ctx, 'k1', 1024)).toEqual({ unavailable: true });
  });
});

// ── OpenCode ────────────────────────────────────────────────────────────────

describe('opencode — the helper, run for real against a stand-in binary', () => {
  it('hands back stdout on exit 0, null on a non-zero exit or a binary that is not there', async () => {
    const ok = await fakeBinary('opencode', 'printf \'["%s"]\' "$*"');
    expect(await execOpencode(['session', 'list'], ok.ctx)).toBe('["session list"]');
    const failed = await fakeBinary('opencode', 'printf partial\nexit 2');
    expect(await execOpencode(['export', 'x'], failed.ctx)).toBeNull();
    expect(await execOpencode(['x'], { ...ok.ctx, env: { PATH: ok.dir + '/missing' } })).toBeNull();
  });

  it('null when the spawn itself is refused', async () => {
    const ok = await fakeBinary('opencode', 'exit 0');
    expect(
      await execOpencode(['x'], { ...ok.ctx, env: { PATH: ok.dir, BAD: 'nul\0byte' } }),
    ).toBeNull();
  });

  it('null, and the helper killed, when it outlives its time', async () => {
    const slow = await fakeBinary('opencode', 'while :; do :; done');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answer = execOpencode(['session', 'list'], slow.ctx);
    vi.advanceTimersByTime(20_000);
    expect(await answer).toBeNull();
  });

  it('the adapter lists and exports through it', async () => {
    const { ctx } = await fakeBinary(
      'opencode',
      'if [ "$1" = export ]; then printf \'{"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"hi"}]}]}\'; else printf \'banner [{"id":"ses_1","updated":1790000000000,"directory":"%s"}]\' "$PWD"; fi',
    );
    const adapter = createOpencodeAdapter();
    expect(await adapter.listSessions(ctx, 50)).toEqual([
      { id: 'ses_1', title: 'ses_1', updatedAt: new Date(1_790_000_000_000).toISOString() },
    ]);
    expect(await adapter.readHistory(ctx, 'ses_1', 1024)).toEqual({
      truncated: false,
      events: [
        { k: 'user', text: 'hi' },
        { k: 'turn_end', reason: 'completed' },
      ],
    });
    expect(await adapter.readHistory(ctx, '../x', 1024)).toEqual({ unavailable: true });
    const broken = createOpencodeAdapter(async () => null);
    expect(await broken.listSessions(ctx, 50)).toEqual([]);
    expect(await broken.readHistory(ctx, 'ses_1', 1024)).toEqual({ unavailable: true });
  });
});

describe('opencode — the mapper and the export on parts no fixture carries', () => {
  it('tool parts with their state absent, errors with their data absent, text with no id', () => {
    const m = createOpencodeMapper();
    const tool = (part: Record<string, unknown>) => ({ type: 'tool_use', part });
    expect(
      lines(
        m,
        '[1]',
        { type: 'text' },
        { type: 'text', part: { text: 'no id' } },
        tool({}),
        tool({
          tool: 'bash',
          id: 'b',
          state: { status: 'completed', metadata: { output: 'meta out', exit: 0 } },
        }),
        tool({ tool: 'edit', callID: 'e', state: { status: 'error', input: { path: 'p' } } }),
        tool({
          tool: 'read',
          callID: 'r',
          state: { status: 'completed', metadata: { filepath: 'f' } },
        }),
        { type: 'error' },
        { type: 'error', error: { message: 'plain' } },
        { type: 'error', error: { name: 'APIError', data: { message: 'x'.repeat(3000) } } },
      ),
    ).toEqual([
      { k: 'text', id: 'opencode-1', delta: 'no id' },
      { k: 'tool_call', id: 'opencode-2', kind: 'other', name: 'tool', title: 'tool' },
      { k: 'tool_call', id: 'b', kind: 'command', name: 'bash', title: 'bash' },
      { k: 'tool_result', id: 'b', ok: true, output: 'meta out', exitCode: 0, truncated: false },
      { k: 'tool_call', id: 'e', kind: 'edit', name: 'edit', title: 'p', path: 'p' },
      { k: 'tool_result', id: 'e', ok: false, output: '', truncated: false },
      { k: 'tool_call', id: 'r', kind: 'read', name: 'read', title: 'f', path: 'f' },
      { k: 'tool_result', id: 'r', ok: true, truncated: false },
      { k: 'error', code: 'error' },
      { k: 'error', code: 'error', message: 'plain' },
      { k: 'error', code: 'APIError', message: 'x'.repeat(2000) },
    ]);
  });

  it('the session list skips what it cannot place', () => {
    expect(parseOpencodeSessionList('no list', '/w', 50)).toEqual([]);
    expect(parseOpencodeSessionList('[oops', '/w', 50)).toEqual([]);
    expect(
      parseOpencodeSessionList(
        JSON.stringify([
          'x',
          { id: 'ses_a' },
          { id: '../b', updated: 1 },
          { id: 'ses_c', created: 5, title: '' },
          { id: 'ses_d', updated: 9, directory: '/elsewhere' },
        ]),
        '/w',
        50,
      ),
    ).toEqual([{ id: 'ses_c', title: 'ses_c', updatedAt: new Date(5).toISOString() }]);
    expect(parseOpencodeSessionList('[{"id":"ses_e","updated":1}]', '/w', -1)).toEqual([]);
  });

  it('the export: stray messages, an assistant before any prompt, aborted and failed ends, untexted parts', () => {
    const exported = {
      messages: [
        'x',
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'orphan' }] },
        { info: { role: 'system' } },
        { info: { role: 'user' } },
        {
          info: { role: 'assistant', error: { name: 'MessageAbortedError' } },
          parts: ['x', { type: 'text' }, { type: 'text', text: 'partial' }, { type: 'reasoning' }],
        },
        {
          info: { role: 'user' },
          parts: [
            { type: 'text', text: 'real' },
            { type: 'text', text: 'synthetic', synthetic: true },
            { type: 'text' },
            { type: 'file' },
          ],
        },
        {
          info: { role: 'assistant', error: { name: 'ProviderAuthError' } },
          parts: [
            {
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: { command: 'ls' } },
            },
          ],
        },
      ],
    };
    expect(parseOpencodeExport(JSON.stringify(exported), 1024 * 1024)).toEqual({
      truncated: false,
      events: [
        { k: 'text', id: 'opencode-history-1', delta: 'orphan' },
        { k: 'turn_end', reason: 'completed' },
        { k: 'user', text: '' },
        { k: 'text', id: 'opencode-history-2', delta: 'partial' },
        { k: 'turn_end', reason: 'stopped' },
        { k: 'user', text: 'real\n' },
        {
          k: 'tool_call',
          id: 'opencode-history-3',
          kind: 'command',
          name: 'bash',
          title: 'ls',
          command: 'ls',
        },
        { k: 'tool_result', id: 'opencode-history-3', ok: true, truncated: false },
        { k: 'turn_end', reason: 'failed' },
      ],
    });
    expect(parseOpencodeExport('{"messages":"no"}', 1024)).toBeNull();
    expect(parseOpencodeExport('no object', 1024)).toBeNull();
  });
});
