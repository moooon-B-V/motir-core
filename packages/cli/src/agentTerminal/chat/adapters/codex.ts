import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatAdapter, ChatContext, TranscriptMapper, TurnCommand } from '../adapter.js';
import { boundTail, type ChatSessionSummary, type TranscriptEvent } from '../protocol.js';

// The Codex chat adapter (MOTIR-7015 · `docs/decisions/agent-chat.md` Q1's
// `codex` row, Q3, Q5, Q7, Q11).
//
// A turn is the unmodified `codex exec --json`, the prompt on stdin (`-`), in
// `$HOME/workspace`. Codex's `exec` defaults to a read-only sandbox and a
// headless turn has nobody to answer a prompt, so the one setting passed is the
// sandbox matrix's `workspace-write` — as a `-c` override, because `codex exec
// resume` takes no `--sandbox` flag (0.159.2). Nothing else: no API key, no
// base URL, no provider, no model, no flag that forces or hides a sign-in
// method. Codex chats on a ChatGPT sign-in and on an API key alike (Q2's
// _Other vendors_), so `support()` always answers yes; the runner's sign-in
// check (`not_signed_in`) still applies before any turn.
//
// The stream (`codex exec --json`, JSON Lines on stdout):
//
//   thread.started {thread_id}            → the session id (Q4's `session` frame)
//   turn.started                          → nothing
//   item.started   command_execution      → tool_call, kind `command`
//   item.completed command_execution      → tool_result: its output, its exit code
//   item.completed agent_message          → text (a complete message is one delta)
//   item.completed file_change            → tool_call, kind `edit`, per changed path
//                                           (Codex names paths and change kinds, no
//                                           diff — Q5), then its tool_result
//   item.*         mcp_tool_call          → tool_call / tool_result, kind `other`
//   item.*         web_search             → tool_call / tool_result, kind `other`
//   item.completed error                  → error (a non-fatal notice)
//   item.*         reasoning              → DROPPED (Q5)
//   item.started/updated of anything else → nothing; item.completed → other
//   error {message}                       → error; it does not end the turn
//   turn.completed {usage}                → the end marker; usage DROPPED (Q5, Q10)
//   turn.failed {error}                   → error; no end marker, so the turn fails
//   any other JSON line with a `type`     → other; anything else is dropped
//
// Stop is the runner's SIGINT (Q6): Codex exits 1 with no final event, and its
// rollout records `turn_aborted`. The session list and a resume's history come
// from Codex's own rollouts, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`,
// scoped to those whose `session_meta` names `$HOME/workspace` (Q7). Nothing is
// logged here: a line that cannot be mapped is dropped silently.

export const CODEX_PROFILE = 'codex';

/** Q3: the one sandbox setting, as a `-c` override so both forms take it. */
export const CODEX_SANDBOX_OVERRIDE = 'sandbox_mode="workspace-write"';

/** The `exec` flags every turn carries, new or resumed (Q3). */
const TURN_FLAGS = ['--json', '-c', CODEX_SANDBOX_OVERRIDE] as const;

/** How far into a rollout the session list reads for its meta and first prompt. */
const LIST_SCAN_LINES = 400;
/** A rollout file name: `rollout-<timestamp>-<thread id>.jsonl`. */
const ROLLOUT_FILE = /^rollout-.+\.jsonl$/;

type Json = Record<string, unknown>;

function parseObject(line: string): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

/** A command as Codex writes it: a string, or an argv array (rollout `shell` calls). */
function commandText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ');
  }
  return undefined;
}

function toolOutput(
  id: string,
  ok: boolean,
  output: string | undefined,
  exitCode: number | undefined,
): TranscriptEvent {
  const bounded = output === undefined ? undefined : boundTail(output);
  return {
    k: 'tool_result',
    id,
    ok,
    ...(bounded !== undefined ? { output: bounded.text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    truncated: bounded?.truncated ?? false,
  };
}

/** The text blocks of an MCP result (`{content:[{type:"text",text}]}`), joined. */
function mcpResultText(result: unknown): string | undefined {
  const content = obj(result)?.['content'];
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((block) => (obj(block)?.['type'] === 'text' ? str(obj(block)?.['text']) : undefined))
    .filter((text): text is string => text !== undefined);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

// ── The live stream (Q5) ────────────────────────────────────────────────────

export function createCodexMapper(): TranscriptMapper {
  let thread: string | null = null;
  let ended = false;
  /** Tool items whose `tool_call` has been written (by `item.started`). */
  const called = new Set<string>();

  const commandCall = (item: Json, id: string): TranscriptEvent => {
    const command = str(item['command']) ?? '';
    return {
      k: 'tool_call',
      id,
      kind: 'command',
      name: 'command_execution',
      title: command,
      command,
    };
  };

  const mcpCall = (item: Json, id: string): TranscriptEvent => {
    const server = str(item['server']);
    const tool = str(item['tool']) ?? 'mcp_tool_call';
    const name = server ? `${server}.${tool}` : tool;
    return { k: 'tool_call', id, kind: 'other', name, title: name };
  };

  const searchCall = (item: Json, id: string): TranscriptEvent => ({
    k: 'tool_call',
    id,
    kind: 'other',
    name: 'web_search',
    title: str(item['query']) ?? 'web_search',
  });

  const onStarted = (item: Json, id: string): TranscriptEvent[] => {
    let call: TranscriptEvent | null = null;
    switch (item['type']) {
      case 'command_execution':
        call = commandCall(item, id);
        break;
      case 'mcp_tool_call':
        call = mcpCall(item, id);
        break;
      case 'web_search':
        call = searchCall(item, id);
        break;
      default:
        return [];
    }
    if (called.has(id)) return [];
    called.add(id);
    return [call];
  };

  const withCall = (
    id: string,
    call: TranscriptEvent,
    rest: TranscriptEvent[],
  ): TranscriptEvent[] => (called.has(id) ? rest : [call, ...rest]);

  const onCompleted = (item: Json, id: string): TranscriptEvent[] => {
    const status = str(item['status']);
    switch (item['type']) {
      case 'agent_message': {
        const text = str(item['text']);
        return text ? [{ k: 'text', id, delta: text }] : [];
      }
      case 'reasoning':
        return [];
      case 'command_execution': {
        const exitCode = num(item['exit_code']);
        const ok = status !== 'failed' && status !== 'declined' && (exitCode ?? 0) === 0;
        return withCall(id, commandCall(item, id), [
          toolOutput(id, ok, str(item['aggregated_output']) ?? '', exitCode),
        ]);
      }
      case 'file_change': {
        const changes = Array.isArray(item['changes']) ? item['changes'] : [];
        const ok = status !== 'failed';
        const events: TranscriptEvent[] = [];
        changes.forEach((change, index) => {
          const path = str(obj(change)?.['path']);
          if (!path) return;
          const kind = str(obj(change)?.['kind']) ?? 'update';
          const callId = changes.length === 1 ? id : `${id}:${index}`;
          events.push(
            {
              k: 'tool_call',
              id: callId,
              kind: 'edit',
              name: 'file_change',
              title: `${kind} ${path}`,
              path,
            },
            toolOutput(callId, ok, undefined, undefined),
          );
        });
        return events;
      }
      case 'mcp_tool_call': {
        const error = str(obj(item['error'])?.['message']);
        const ok = status !== 'failed' && error === undefined;
        return withCall(id, mcpCall(item, id), [
          toolOutput(id, ok, error ?? mcpResultText(item['result']), undefined),
        ]);
      }
      case 'web_search':
        return withCall(id, searchCall(item, id), [
          toolOutput(id, status !== 'failed', undefined, undefined),
        ]);
      case 'error': {
        const message = str(item['message']);
        return [{ k: 'error', code: 'codex_error', ...(message ? { message } : {}) }];
      }
      default: {
        const type = str(item['type']);
        return type ? [{ k: 'other', name: type }] : [];
      }
    }
  };

  return {
    onLine(line) {
      const event = parseObject(line);
      if (!event) return [];
      const type = str(event['type']);
      if (!type) return [];
      switch (type) {
        case 'thread.started': {
          const id = str(event['thread_id']);
          if (id) thread = id;
          return [];
        }
        case 'turn.started':
          return [];
        case 'turn.completed':
          // The end marker. `usage` is dropped (Q5, Q10).
          ended = true;
          return [];
        case 'turn.failed': {
          const message = str(obj(event['error'])?.['message']);
          return [{ k: 'error', code: 'turn_failed', ...(message ? { message } : {}) }];
        }
        case 'error': {
          const message = str(event['message']);
          return [{ k: 'error', code: 'codex_error', ...(message ? { message } : {}) }];
        }
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = obj(event['item']);
          const id = str(item?.['id']);
          if (!item || !id) return [{ k: 'other', name: type }];
          if (type === 'item.completed') return onCompleted(item, id);
          if (type === 'item.started') return onStarted(item, id);
          return [];
        }
        default:
          return [{ k: 'other', name: type }];
      }
    },
    sessionId: () => thread,
    sawEnd: () => ended,
    killCode: () => null,
  };
}

// ── The store (Q7) ──────────────────────────────────────────────────────────

/** `$CODEX_HOME`, which the image points at `$HOME/.motir-sandbox/agent-config/.codex`. */
export function codexHome(ctx: ChatContext): string {
  const configured = ctx.env['CODEX_HOME']?.trim();
  return configured ? configured : join(ctx.home, '.codex');
}

interface RolloutFile {
  path: string;
  mtimeMs: number;
}

/** Every rollout under `sessions/`, at any depth (Codex nests them YYYY/MM/DD). */
async function rolloutFiles(root: string): Promise<RolloutFile[]> {
  const found: RolloutFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(path, depth + 1);
      } else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
        try {
          found.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  };
  await walk(join(root, 'sessions'), 0);
  return found;
}

/** Read a rollout line by line; `visit` returns true to stop early. */
async function readLines(path: string, visit: (line: Json) => boolean | void): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      const line = parseObject(text);
      if (line && visit(line) === true) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

interface RolloutHead {
  id: string | null;
  cwd: string | null;
  firstPrompt: string | null;
}

/** The rollout's `session_meta` and its first `user_message`. */
async function readHead(path: string): Promise<RolloutHead> {
  const head: RolloutHead = { id: null, cwd: null, firstPrompt: null };
  let seen = 0;
  await readLines(path, (line) => {
    seen += 1;
    const payload = obj(line['payload']);
    if (line['type'] === 'session_meta' && payload && head.id === null) {
      head.id = str(payload['id']) ?? null;
      head.cwd = str(payload['cwd']) ?? null;
      // A session in another directory is out of scope: stop reading it.
      if (head.cwd === null) return true;
    } else if (line['type'] === 'event_msg' && payload?.['type'] === 'user_message') {
      head.firstPrompt = str(payload['message']) ?? null;
      if (head.firstPrompt !== null) return true;
    }
    return seen >= LIST_SCAN_LINES;
  });
  return head;
}

/** Newest first by last activity (the rollout's mtime), scoped to `ctx.cwd`, at most `limit`. */
export async function listCodexSessions(
  ctx: ChatContext,
  limit: number,
): Promise<ChatSessionSummary[]> {
  const files = await rolloutFiles(codexHome(ctx));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const items: ChatSessionSummary[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (items.length >= limit) break;
    let head: RolloutHead;
    try {
      head = await readHead(file.path);
    } catch {
      continue;
    }
    if (head.id === null || head.cwd !== ctx.cwd || seen.has(head.id)) continue;
    seen.add(head.id);
    items.push({
      id: head.id,
      title: (head.firstPrompt ?? '').trim() || head.id,
      updatedAt: new Date(file.mtimeMs).toISOString(),
    });
  }
  return items;
}

/** The rollout of one thread: its file name ends in the id, and its meta says so. */
async function findRollout(ctx: ChatContext, sessionId: string): Promise<string | null> {
  const files = (await rolloutFiles(codexHome(ctx)))
    .filter((file) => file.path.endsWith(`-${sessionId}.jsonl`))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files) {
    const head = await readHead(file.path).catch(() => null);
    if (head?.id === sessionId && head.cwd === ctx.cwd) return file.path;
  }
  return null;
}

/**
 * A resumed session's earlier turns, from the rollout (Q7): each
 * `user_message` opens a turn; `agent_message` is its text; the model's
 * `shell` calls and `apply_patch` edits are its tool rows; `turn_aborted`
 * ends a turn `stopped`. Reasoning and token counts are dropped (Q5). The
 * newest turns that fit `budgetBytes` are kept.
 */
export async function readCodexHistory(
  ctx: ChatContext,
  sessionId: string,
  budgetBytes: number,
): Promise<{ events: TranscriptEvent[]; truncated: boolean } | { unavailable: true }> {
  const path = await findRollout(ctx, sessionId);
  if (path === null) return { unavailable: true };
  const turns: TranscriptEvent[][] = [];
  let turn: TranscriptEvent[] | null = null;
  let ended = true;
  let texts = 0;
  const close = (reason: 'completed' | 'stopped'): void => {
    if (turn && !ended) turn.push({ k: 'turn_end', reason });
    ended = true;
  };
  await readLines(path, (line) => {
    const payload = obj(line['payload']);
    if (!payload) return;
    const kind = str(payload['type']);
    if (line['type'] === 'event_msg') {
      if (kind === 'user_message') {
        close('completed');
        turn = [{ k: 'user', text: str(payload['message']) ?? '' }];
        turns.push(turn);
        ended = false;
      } else if (kind === 'agent_message' && turn && !ended) {
        const text = str(payload['message']);
        if (text) turn.push({ k: 'text', id: `history-${++texts}`, delta: text });
      } else if (kind === 'turn_aborted') {
        close('stopped');
      }
      return;
    }
    if (line['type'] !== 'response_item' || !turn || ended) return;
    const callId = str(payload['call_id']);
    if (!callId) return;
    if (kind === 'function_call') {
      const args = parseObject(str(payload['arguments']) ?? '');
      const command = commandText(args?.['command'] ?? args?.['cmd']);
      const name = str(payload['name']) ?? 'function_call';
      turn.push(
        command !== undefined
          ? { k: 'tool_call', id: callId, kind: 'command', name, title: command, command }
          : { k: 'tool_call', id: callId, kind: 'other', name, title: name },
      );
    } else if (kind === 'custom_tool_call') {
      const name = str(payload['name']) ?? 'custom_tool_call';
      const input = str(payload['input']);
      const target = input?.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1];
      turn.push(
        name === 'apply_patch' && input !== undefined
          ? {
              k: 'tool_call',
              id: callId,
              kind: 'edit',
              name,
              title: target ?? name,
              ...(target ? { path: target } : {}),
              diff: boundTail(input).text,
            }
          : { k: 'tool_call', id: callId, kind: 'other', name, title: name },
      );
    } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const raw = payload['output'];
      const text = str(raw) ?? str(obj(raw)?.['content']);
      // Older rollouts wrap it as `{"output","metadata":{"exit_code"}}`.
      const wrapped = text !== undefined ? parseObject(text) : null;
      const output = str(wrapped?.['output']) ?? text;
      // Newer ones lead with an `Exit code: N` line.
      const exitLine = text?.match(/^Exit code: (-?\d+)$/m)?.[1];
      const exitCode =
        num(obj(wrapped?.['metadata'])?.['exit_code']) ??
        (exitLine !== undefined ? Number(exitLine) : undefined);
      turn.push(toolOutput(callId, (exitCode ?? 0) === 0, output, exitCode));
    }
  });
  close('completed');
  // Newest turns kept within the budget.
  const kept: TranscriptEvent[][] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const events = turns[index] as TranscriptEvent[];
    const size = Buffer.byteLength(JSON.stringify(events), 'utf8');
    if (bytes + size > budgetBytes) break;
    bytes += size;
    kept.unshift(events);
  }
  return { events: kept.flat(), truncated: kept.length < turns.length };
}

// ── The adapter ─────────────────────────────────────────────────────────────

export function codexTurnCommand(input: { prompt: string; sessionId: string | null }): TurnCommand {
  const args =
    input.sessionId === null
      ? ['exec', ...TURN_FLAGS, '-']
      : ['exec', 'resume', ...TURN_FLAGS, input.sessionId, '-'];
  // The prompt rides stdin (`-`), so it is not in the process table (Q3).
  return { file: 'codex', args, stdin: input.prompt };
}

export const codexChatAdapter: ChatAdapter = {
  profile: CODEX_PROFILE,
  // Q2: Codex chats on either sign-in. The runner's sign-in gate still applies.
  support: async () => ({ supported: true }),
  turnCommand: codexTurnCommand,
  createMapper: createCodexMapper,
  listSessions: listCodexSessions,
  readHistory: readCodexHistory,
};
