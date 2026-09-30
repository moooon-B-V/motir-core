import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
// Types only: `adapter.ts` imports this module to register it, so a value
// import back would be a cycle that breaks whichever file loads first.
import type {
  ChatAdapter,
  ChatContext,
  ChatSupport,
  TranscriptMapper,
  TurnCommand,
} from '../adapter.js';
import {
  boundTail,
  isSessionId,
  type ChatErrorCode,
  type ChatSessionSummary,
  type ToolKind,
  type TranscriptEvent,
} from '../protocol.js';

// The Claude Code chat adapter (MOTIR-7014 · `docs/decisions/agent-chat.md` Q1's
// `claude` row, Q2 option (b), Q3, Q5, Q6, Q7, Q10, Q11).
//
// ⚠️ THE CHAT RUNS ONLY ON AN ANTHROPIC API KEY OR A CLOUD-PROVIDER SIGN-IN,
// NEVER ON A CLAUDE SUBSCRIPTION (Q2 (b)). Anthropic's terms direct a product
// that interacts with Claude's capabilities to API-key or cloud-provider
// authentication, and do not clearly allow a third-party interface to drive a
// Claude.ai sign-in. Two checks hold that line:
//
//   - THE GATE, `support()`: the vendor's own `claude auth status --json`. Chat
//     is allowed when `apiProvider` is present and is not `firstParty` (a cloud
//     provider), or when `apiKeySource` is present and is not `none` (a key the
//     user configured). Anything else — including an answer that cannot be
//     read — is refused, and no turn process is ever started.
//   - THE BACKSTOP, per turn: the stream's `system/init` line carries
//     `apiKeySource`. `none` there, on a turn the gate did not pass as a cloud
//     provider, asks the runner for an immediate kill, and the turn ends
//     `failed` with `subscription_signin`. It covers a sign-in changed between
//     the probe and the turn.
//
// Both read only the binary's answers, never a credential file. Motir SETS
// NOTHING to make the chat work (Q11): no `ANTHROPIC_API_KEY`, no
// `apiKeyHelper`, no `--bare` (which would disable OAuth, a restriction of a
// built-in sign-in). The binary is spawned as the image installed it.
//
// ⚠️ NOTHING HERE LOGS (Q10). Prompts, replies, tool inputs and outputs, paths,
// session ids and titles go to the transcript and nowhere else; errors from the
// probe or the store are swallowed, never printed.

/** Q1: the version the fixtures were derived from. The adapter owns the drift. */
export const CLAUDE_FIXTURE_VERSION = '2.1.280';

const BINARY = 'claude';
/** `adapter.ts` `UNSUPPORTED` and `MAX_TITLE_CHARS` (Q1, Q7), restated to keep the import type-only. */
const UNSUPPORTED: ChatSupport = { supported: false, code: 'unsupported' };
const MAX_TITLE_CHARS = 120;
/** The probe's bound: an answer that does not come in this time is not a yes. */
const PROBE_TIMEOUT_MS = 15_000;
/** How much of a session file the list reads to find its title. */
const TITLE_SCAN_BYTES = 64 * 1024;
/** The most of one session file a resume reads (its newest part). */
const HISTORY_SCAN_BYTES = 8 * 1024 * 1024;

// ── The gate ───────────────────────────────────────────────────────────────

/** `claude auth status --json`'s answer, the fields the gate reads. */
export interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  apiKeySource?: string;
}

export type ClaudeSignInKind = 'api_key' | 'cloud_provider' | 'subscription';

/**
 * Q2 (b): which sign-in an auth-status answer describes. A cloud provider
 * first (its turns carry no Anthropic key at all), then a configured key;
 * everything else — an OAuth sign-in, no sign-in, a missing field — is
 * treated as the subscription the chat must not drive.
 */
export function classifyClaudeAuth(status: ClaudeAuthStatus): ClaudeSignInKind {
  const provider = typeof status.apiProvider === 'string' ? status.apiProvider : null;
  if (provider !== null && provider !== '' && provider !== 'firstParty') return 'cloud_provider';
  const source = typeof status.apiKeySource === 'string' ? status.apiKeySource : null;
  if (source !== null && source !== '' && source !== 'none') return 'api_key';
  return 'subscription';
}

/**
 * Runs `claude auth status --json` and resolves its stdout. The binary exits
 * non-zero when signed out, so stdout is resolved whatever the exit code; a
 * binary that could not run rejects.
 */
export type ClaudeProbe = (ctx: ChatContext) => Promise<string>;

/** The real probe: the binary directly, no shell, in the chat's cwd and env. */
export const runClaudeAuthStatus: ClaudeProbe = (ctx) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...ctx.env };
    delete env['MOTIR_TERMINAL_KEY'];
    execFile(
      BINARY,
      ['auth', 'status', '--json'],
      {
        cwd: ctx.cwd,
        env: env as NodeJS.ProcessEnv,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        if (out.trim().length > 0) return resolve(out);
        // The error may name a path; it is passed on only as a rejection, never logged.
        reject(error ?? new Error('no answer'));
      },
    );
  });

function parseAuthStatus(text: string): ClaudeAuthStatus | null {
  // The answer is one JSON object; tolerate a banner line before it.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as ClaudeAuthStatus;
  } catch {
    return null;
  }
}

// ── The mapping (Q5) ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** One hunk of a unified diff from an old and a new string (no line numbers are known). */
function hunk(oldText: string, newText: string): string {
  const removed = splitLines(oldText);
  const added = splitLines(newText);
  const lines = [`@@ -${removed.length} +${added.length} @@`];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return lines.join('\n');
}

/** Q5: the unified diff an `Edit` / `MultiEdit` / `Write` input carries. */
function diffOf(name: string, input: Json, path: string): string | undefined {
  const header = `--- a/${path.replace(/^\/+/, '')}\n+++ b/${path.replace(/^\/+/, '')}`;
  if (name === 'Edit') {
    const oldString = str(input['old_string']);
    const newString = str(input['new_string']);
    if (oldString === undefined || newString === undefined) return undefined;
    return `${header}\n${hunk(oldString, newString)}\n`;
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input['edits']) ? input['edits'] : [];
    const hunks: string[] = [];
    for (const edit of edits) {
      if (!isObject(edit)) continue;
      const oldString = str(edit['old_string']);
      const newString = str(edit['new_string']);
      if (oldString === undefined || newString === undefined) continue;
      hunks.push(hunk(oldString, newString));
    }
    return hunks.length > 0 ? `${header}\n${hunks.join('\n')}\n` : undefined;
  }
  if (name === 'Write') {
    const content = str(input['content']);
    if (content === undefined) return undefined;
    return `${header}\n${hunk('', content)}\n`;
  }
  return undefined;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** Q5: a `tool_use` block → one `tool_call`. */
export function toolCallEvent(block: Json): TranscriptEvent | null {
  const id = str(block['id']);
  const name = str(block['name']);
  if (!id || !name) return null;
  const input = isObject(block['input']) ? block['input'] : {};
  if (name === 'Read') {
    const path = str(input['file_path']);
    return {
      k: 'tool_call',
      id,
      kind: 'read',
      name,
      title: path ?? name,
      ...(path ? { path } : {}),
    };
  }
  if (EDIT_TOOLS.has(name)) {
    const path = str(input['file_path']);
    const diff = path ? diffOf(name, input, path) : undefined;
    return {
      k: 'tool_call',
      id,
      kind: 'edit',
      name,
      title: path ?? name,
      ...(path ? { path } : {}),
      ...(diff !== undefined ? { diff: boundTail(diff).text } : {}),
    };
  }
  if (name === 'Bash') {
    const command = str(input['command']);
    const description = str(input['description']);
    return {
      k: 'tool_call',
      id,
      kind: 'command',
      name,
      title: description || command || name,
      ...(command !== undefined ? { command } : {}),
    };
  }
  const kind: ToolKind = 'other';
  return { k: 'tool_call', id, kind, name, title: name };
}

/** A `tool_result` block's content, as text (text parts only; an image is not text). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  return parts.join('\n');
}

/** Q5: a `tool_result` block → one `tool_result`. A failed Bash names its exit code. */
export function toolResultEvent(block: Json): TranscriptEvent | null {
  const id = str(block['tool_use_id']);
  if (!id) return null;
  const ok = block['is_error'] !== true;
  const bounded = boundTail(resultText(block['content']));
  const exit = ok ? null : /^Exit code (\d+)/.exec(bounded.text);
  return {
    k: 'tool_result',
    id,
    ok,
    output: bounded.text,
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
    truncated: bounded.truncated,
  };
}

/** `system` subtypes that are lifecycle noise, dropped rather than drawn. */
const DROPPED_SYSTEM = new Set(['hook_started', 'hook_progress', 'hook_response', 'status']);
/** Top-level line types that are recognised and carry nothing the transcript draws. */
const DROPPED_TYPES = new Set(['rate_limit_event', 'keep_alive']);

/**
 * Q5: a fresh mapper for one turn. `trustNoKey` is true when the gate passed
 * the turn as a cloud provider, whose `init` honestly reads `apiKeySource:
 * "none"` — the backstop then has nothing to catch.
 */
export function createClaudeMapper(options: { trustNoKey?: boolean } = {}): TranscriptMapper {
  let session: string | null = null;
  let ended = false;
  let kill: ChatErrorCode | null = null;
  /** Assistant message ids whose text already arrived as `stream_event` deltas. */
  const streamed = new Set<string>();
  /** The message the current `stream_event`s belong to. */
  let streamingMessage: string | null = null;
  /** Tool calls and results already emitted, by id, so a repeat is never drawn twice. */
  const calls = new Set<string>();
  const results = new Set<string>();

  const onStreamEvent = (value: Json): TranscriptEvent[] => {
    const event = isObject(value['event']) ? value['event'] : null;
    if (!event) return [];
    if (event['type'] === 'message_start') {
      const message = isObject(event['message']) ? event['message'] : null;
      streamingMessage = str(message?.['id']) ?? null;
      return [];
    }
    if (event['type'] !== 'content_block_delta') return [];
    const delta = isObject(event['delta']) ? event['delta'] : null;
    // Thinking and tool-input deltas are dropped; the tool call is drawn from
    // the complete assistant message, which carries the whole input.
    if (!delta || delta['type'] !== 'text_delta') return [];
    const text = str(delta['text']);
    if (!text || streamingMessage === null) return [];
    streamed.add(streamingMessage);
    const index = typeof event['index'] === 'number' ? event['index'] : 0;
    return [{ k: 'text', id: `${streamingMessage}:${index}`, delta: text }];
  };

  const onAssistant = (value: Json): TranscriptEvent[] => {
    const message = isObject(value['message']) ? value['message'] : null;
    if (!message || !Array.isArray(message['content'])) return [];
    const messageId = str(message['id']) ?? str(value['uuid']) ?? 'message';
    const events: TranscriptEvent[] = [];
    message['content'].forEach((block, index) => {
      if (!isObject(block)) return;
      if (block['type'] === 'text') {
        // Already streamed word by word: the whole message is not drawn twice.
        if (streamed.has(messageId)) return;
        const text = str(block['text']);
        if (text) events.push({ k: 'text', id: `${messageId}:t${index}`, delta: text });
        return;
      }
      if (block['type'] === 'tool_use') {
        const call = toolCallEvent(block);
        if (call && call.k === 'tool_call' && !calls.has(call.id)) {
          calls.add(call.id);
          events.push(call);
        }
      }
      // thinking / redacted_thinking: dropped, never mapped (Q5).
    });
    return events;
  };

  const onUser = (value: Json): TranscriptEvent[] => {
    const message = isObject(value['message']) ? value['message'] : null;
    if (!message || !Array.isArray(message['content'])) return [];
    const events: TranscriptEvent[] = [];
    for (const block of message['content']) {
      if (!isObject(block) || block['type'] !== 'tool_result') continue;
      const result = toolResultEvent(block);
      if (result && result.k === 'tool_result' && !results.has(result.id)) {
        results.add(result.id);
        events.push(result);
      }
    }
    return events;
  };

  const onResult = (value: Json): TranscriptEvent[] => {
    // Q6: the SIGINT result is the stopped end, consumed rather than shown. It
    // is not an end marker either: a turn nobody stopped that ends this way
    // did not complete.
    if (value['terminal_reason'] === 'aborted_streaming') return [];
    ended = true;
    if (value['subtype'] === 'success' && value['is_error'] !== true) return [];
    // Cost, usage and duration fields are dropped (Q5, Q10); the reason is kept.
    const code = str(value['subtype']) ?? 'error';
    const message = str(value['result']);
    return [{ k: 'error', code, ...(message ? { message } : {}) }];
  };

  const onSystem = (value: Json): TranscriptEvent[] => {
    const subtype = str(value['subtype']) ?? '';
    if (subtype === 'init') {
      // Q2's backstop: a turn about to run on no Anthropic key.
      if (value['apiKeySource'] === 'none' && !options.trustNoKey) kill = 'subscription_signin';
      return [];
    }
    if (subtype === 'api_retry') return [{ k: 'error', code: 'api_retry' }];
    if (DROPPED_SYSTEM.has(subtype)) return [];
    return [{ k: 'other', name: subtype ? `system/${subtype}` : 'system' }];
  };

  return {
    onLine(line) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return [];
      }
      if (!isObject(value)) return [];
      const type = str(value['type']);
      if (!type) return [];
      const id = str(value['session_id']);
      if (id && session === null && isSessionId(id)) session = id;
      // A subagent's own stream (Task) is summarised by its tool result.
      if (typeof value['parent_tool_use_id'] === 'string') return [];
      switch (type) {
        case 'system':
          return onSystem(value);
        case 'stream_event':
          return onStreamEvent(value);
        case 'assistant':
          return onAssistant(value);
        case 'user':
          return onUser(value);
        case 'result':
          return onResult(value);
        default:
          return DROPPED_TYPES.has(type) ? [] : [{ k: 'other', name: type }];
      }
    },
    sessionId: () => session,
    sawEnd: () => ended,
    killCode: () => kill,
  };
}

// ── The store (Q7) ─────────────────────────────────────────────────────────

/** `$CLAUDE_CONFIG_DIR/projects/<cwd>` — Claude Code names a project dir by its cwd, each non-alphanumeric → `-`. */
export function claudeProjectDir(ctx: ChatContext): string {
  const configDir = ctx.env['CLAUDE_CONFIG_DIR'] || join(ctx.home, '.claude');
  return join(configDir, 'projects', ctx.cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Read at most `max` bytes of a file, from its start or its end. */
async function readBounded(
  path: string,
  max: number,
  from: 'start' | 'end',
): Promise<{ text: string; cut: boolean }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, max);
    const position = from === 'end' ? size - length : 0;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    let text = buffer.toString('utf8');
    const cut = size > max;
    // A cut leaves a partial line at the cut edge; it is dropped.
    if (cut && from === 'end') text = text.slice(text.indexOf('\n') + 1);
    if (cut && from === 'start') text = text.slice(0, text.lastIndexOf('\n') + 1);
    return { text, cut };
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) out.push(value);
    } catch {
      // A torn or foreign line is skipped.
    }
  }
  return out;
}

/** A store entry that is the developer's own prompt (not a tool result, a meta line or a slash command). */
function promptOf(entry: Json): string | null {
  if (entry['type'] !== 'user' || entry['isMeta'] === true || entry['isSidechain'] === true) {
    return null;
  }
  const message = isObject(entry['message']) ? entry['message'] : null;
  if (!message) return null;
  const content = message['content'];
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((part) => isObject(part) && part['type'] === 'tool_result')) return null;
    text = resultText(content);
  }
  if (!text || !text.trim()) return null;
  const trimmed = text.trimStart();
  if (/^<(command-|local-command-)/.test(trimmed) || trimmed.startsWith('Caveat:')) return null;
  return text;
}

function cutTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length <= MAX_TITLE_CHARS ? oneLine : chars.slice(0, MAX_TITLE_CHARS).join('');
}

/** Q7: the CLI's own title (a `summary` line) where it keeps one, else the first prompt. */
function titleOf(entries: Json[]): string | null {
  let summary: string | null = null;
  let firstPrompt: string | null = null;
  for (const entry of entries) {
    if (entry['type'] === 'summary' && typeof entry['summary'] === 'string') {
      summary = entry['summary'];
    }
    if (firstPrompt === null) firstPrompt = promptOf(entry);
  }
  const title = summary ?? firstPrompt;
  return title === null ? null : cutTitle(title);
}

export async function listClaudeSessions(
  ctx: ChatContext,
  limit: number,
): Promise<ChatSessionSummary[]> {
  const dir = claudeProjectDir(ctx);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: { id: string; path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isSessionId(id)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) files.push({ id, path, mtimeMs: info.mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const out: ChatSessionSummary[] = [];
  for (const file of files) {
    if (out.length >= limit) break;
    let title: string | null = null;
    try {
      title = titleOf(
        parseJsonLines((await readBounded(file.path, TITLE_SCAN_BYTES, 'start')).text),
      );
    } catch {
      continue;
    }
    // A session with no prompt of its own is not one to continue.
    if (title === null) continue;
    out.push({ id: file.id, title, updatedAt: new Date(file.mtimeMs).toISOString() });
  }
  return out;
}

/** Q7: a stored session's turns, as transcript events, oldest first. */
function historyEvents(entries: Json[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry['isSidechain'] === true) continue;
    const prompt = promptOf(entry);
    if (prompt !== null) {
      events.push({ k: 'user', text: prompt });
      continue;
    }
    const message = isObject(entry['message']) ? entry['message'] : null;
    if (!message || !Array.isArray(message['content'])) continue;
    if (entry['type'] === 'assistant') {
      const messageId = str(message['id']) ?? str(entry['uuid']) ?? 'message';
      message['content'].forEach((block, index) => {
        if (!isObject(block)) return;
        if (block['type'] === 'text' && str(block['text'])) {
          events.push({ k: 'text', id: `${messageId}:h${index}`, delta: block['text'] as string });
        } else if (block['type'] === 'tool_use') {
          const call = toolCallEvent(block);
          if (call && call.k === 'tool_call' && !calls.has(call.id)) {
            calls.add(call.id);
            events.push(call);
          }
        }
      });
    } else if (entry['type'] === 'user') {
      for (const block of message['content']) {
        if (isObject(block) && block['type'] === 'tool_result') {
          const result = toolResultEvent(block);
          if (result) events.push(result);
        }
      }
    }
  }
  return events;
}

/** Keep the newest whole turns (a turn starts at a `user` event) within `budgetBytes`. */
function withinBudget(
  events: TranscriptEvent[],
  budgetBytes: number,
): { events: TranscriptEvent[]; dropped: boolean } {
  const sizes = events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8'));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (total > budgetBytes && start < events.length) {
    // Drop the oldest turn: up to the next `user` event after this one.
    let next = start + 1;
    while (next < events.length && events[next]!.k !== 'user') next++;
    for (let i = start; i < next; i++) total -= sizes[i]!;
    start = next;
  }
  return { events: events.slice(start), dropped: start > 0 };
}

export async function readClaudeHistory(
  ctx: ChatContext,
  sessionId: string,
  budgetBytes: number,
): Promise<{ events: TranscriptEvent[]; truncated: boolean } | { unavailable: true }> {
  if (!isSessionId(sessionId)) return { unavailable: true };
  let read: { text: string; cut: boolean };
  try {
    read = await readBounded(
      join(claudeProjectDir(ctx), `${sessionId}.jsonl`),
      HISTORY_SCAN_BYTES,
      'end',
    );
  } catch {
    return { unavailable: true };
  }
  let events = historyEvents(parseJsonLines(read.text));
  // A file read from a cut may start mid-turn: begin at the first whole turn.
  if (read.cut) {
    const first = events.findIndex((event) => event.k === 'user');
    events = first === -1 ? [] : events.slice(first);
  }
  const bounded = withinBudget(events, budgetBytes);
  return { events: bounded.events, truncated: read.cut || bounded.dropped };
}

// ── The adapter ────────────────────────────────────────────────────────────

export interface ClaudeAdapterOptions {
  /** The `claude auth status --json` probe (the tests inject a fixture). */
  probe?: ClaudeProbe;
  /** A new chat's session id (Q7: Claude Code takes one minted by the server). */
  newSessionId?: () => string;
}

export function createClaudeChatAdapter(options: ClaudeAdapterOptions = {}): ChatAdapter {
  const probe = options.probe ?? runClaudeAuthStatus;
  const newSessionId = options.newSessionId ?? randomUUID;
  /**
   * What the last probe found. The runner probes immediately before every turn
   * (Q6), so the mapper created for that turn reads the answer for it.
   */
  let lastKind: ClaudeSignInKind | null = null;

  return {
    profile: 'claude',

    async support(ctx): Promise<ChatSupport> {
      lastKind = null;
      let answer: string;
      try {
        answer = await probe(ctx);
      } catch {
        // A binary that cannot answer is not a yes (and its error is not logged).
        return UNSUPPORTED;
      }
      const status = parseAuthStatus(answer);
      if (!status) return UNSUPPORTED;
      lastKind = classifyClaudeAuth(status);
      if (lastKind === 'subscription') return { supported: false, code: 'subscription_signin' };
      // An API key or a cloud provider leaves no credential file for the
      // terminal's stat to find; the probe has confirmed the sign-in instead.
      return { supported: true, signedIn: true };
    },

    turnCommand({ prompt, sessionId }): TurnCommand {
      // Q3, exactly: the prompt on stdin, no env addition, never `--bare`.
      return {
        file: BINARY,
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          ...(sessionId === null ? ['--session-id', newSessionId()] : ['--resume', sessionId]),
          '--dangerously-skip-permissions',
        ],
        stdin: prompt,
      };
    },

    createMapper: () => createClaudeMapper({ trustNoKey: lastKind === 'cloud_provider' }),

    listSessions: listClaudeSessions,

    readHistory: readClaudeHistory,
  };
}

/** The registered adapter: the real probe and random session ids. */
export const claudeChatAdapter: ChatAdapter = createClaudeChatAdapter();
