import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { ChatAdapter, ChatContext, TranscriptMapper, TurnCommand } from '../adapter.js';
import {
  boundTail,
  isSessionId,
  type ChatSessionSummary,
  type ToolKind,
  type TranscriptEvent,
} from '../protocol.js';

// The goose chat adapter (MOTIR-7035 · `docs/decisions/agent-chat.md` Q1, Q3,
// Q5, Q6, Q7, Q10, Q11).
//
//   headless  `goose run -q --output-format stream-json -i -`, the prompt on stdin
//   resume    the same, plus `--resume --session-id <id>`
//   env       `GOOSE_MODE=auto` — goose's own auto-approve, and the ONLY addition (Q11)
//   turn end  `{"type":"complete",…}`; its token counts are dropped (Q5, Q10)
//   Stop      SIGINT → `{"type":"error","error":"Headless run interrupted"}`, exit 1.
//             That line is CONSUMED: the runner's `stopped` end is the one marker (Q6).
//   sessions  `goose session list --format json`, scoped to `$HOME/workspace` (Q7)
//
// goose streams one `message` line per chunk, so consecutive text chunks share
// the message's `id` and concatenate in the tab. A `toolRequest` is a tool call,
// its `toolResponse` (carried on a `user`-role message) is the result.
//
// ⚠️ NOTHING HERE LOGS. A line, an error text or a listing is mapped or dropped,
// never written anywhere but the returned events (Q10).

/** The vendor binary, by its bare name on PATH (Q11). */
export const GOOSE_BINARY = 'goose';

/** Q3's new-chat argv. */
export const GOOSE_RUN_ARGS: readonly string[] = [
  'run',
  '-q',
  '--output-format',
  'stream-json',
  '-i',
  '-',
];

/** Q11: the one environment addition, a permission mode that is not a credential. */
export const GOOSE_ENV: Readonly<Record<string, string>> = { GOOSE_MODE: 'auto' };

/** Q6: the error line goose prints when SIGINT interrupts a headless run. */
export const GOOSE_INTERRUPTED = 'Headless run interrupted';

/** How long `goose session list` may take before the list answers empty. */
const LIST_TIMEOUT_MS = 10_000;
/** The largest listing read; goose's is a few hundred bytes per session. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Q7's title bound — `adapter.ts` `MAX_TITLE_CHARS`, restated because
 * `adapter.ts` imports this file into its registry and a value import back
 * would be a cycle. The test pins the two equal.
 */
export const GOOSE_TITLE_CHARS = 120;
/** An `other` row's name is a label, never a payload. */
const MAX_OTHER_NAME = 64;

// ── Mapping (Q5) ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstString(object: Json, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = asString(object[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function otherName(name: string): string {
  return Array.from(name).slice(0, MAX_OTHER_NAME).join('');
}

/** A tool name without an extension prefix: `developer__shell` → `shell`. */
function bareToolName(name: string): string {
  const cut = name.lastIndexOf('__');
  return cut === -1 ? name : name.slice(cut + 2);
}

const COMMAND_TOOLS = new Set(['shell', 'bash', 'run_command', 'command']);
const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'create',
  'str_replace',
  'write_file',
  'edit_file',
  'insert',
]);
const READ_TOOLS = new Set(['view', 'read', 'read_file', 'cat']);

function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A unified diff of one change. goose's tool arguments carry the replaced and
 * the replacing text (or the whole new file), not a diff, so it is built here:
 * one hunk, the removed lines then the added ones.
 */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const removed = before === null ? [] : textLines(before);
  const added = textLines(after);
  const header = [
    `--- ${before === null ? '/dev/null' : path}`,
    `+++ ${path}`,
    `@@ -${removed.length === 0 ? 0 : 1},${removed.length} +${added.length === 0 ? 0 : 1},${added.length} @@`,
  ];
  return [
    ...header,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}

/** Q5's tool-kind mapping for one goose `toolCall` value. */
export function mapToolCall(id: string, rawName: string, args: Json): TranscriptEvent {
  const name = bareToolName(rawName);
  const lower = name.toLowerCase();
  const path = firstString(args, ['path', 'file_path', 'file']);
  if (COMMAND_TOOLS.has(lower)) {
    const command = firstString(args, ['command', 'cmd']) ?? '';
    return { k: 'tool_call', id, kind: 'command', name, title: command || name, command };
  }
  // goose's developer `text_editor` names its operation in `command`.
  const operation = lower === 'text_editor' ? (asString(args['command']) ?? '') : lower;
  let kind: ToolKind = 'other';
  if (READ_TOOLS.has(operation)) kind = 'read';
  else if (EDIT_TOOLS.has(operation) || operation === 'undo_edit') kind = 'edit';
  const event: Extract<TranscriptEvent, { k: 'tool_call' }> = {
    k: 'tool_call',
    id,
    kind,
    name,
    title: path ?? name,
    ...(path !== undefined && kind !== 'other' ? { path } : {}),
  };
  if (kind === 'edit' && path !== undefined) {
    const whole = firstString(args, ['file_text', 'content']);
    const before = firstString(args, ['old_str', 'old_string', 'before']);
    const after = firstString(args, ['new_str', 'new_string', 'after']);
    let diff: string | undefined;
    if (operation === 'write' || operation === 'create' || operation === 'write_file') {
      if (whole !== undefined) diff = unifiedDiff(path, null, whole);
    } else if (operation === 'insert') {
      if (after !== undefined) diff = unifiedDiff(path, '', after);
    } else if (before !== undefined && after !== undefined) {
      diff = unifiedDiff(path, before, after);
    } else if (whole !== undefined) {
      diff = unifiedDiff(path, null, whole);
    }
    if (diff !== undefined) event.diff = boundTail(diff).text;
  }
  return event;
}

/** Q5's result mapping for one goose `toolResult`. */
export function mapToolResult(id: string, toolResult: Json | null): TranscriptEvent {
  if (!toolResult || toolResult['status'] !== 'success') {
    const error = toolResult ? asString(toolResult['error']) : undefined;
    const bounded = boundTail(error ?? '');
    return {
      k: 'tool_result',
      id,
      ok: false,
      ...(error !== undefined ? { output: bounded.text } : {}),
      truncated: bounded.truncated,
    };
  }
  const value = asObject(toolResult['value']) ?? {};
  const structured = asObject(value['structuredContent']);
  let output: string | undefined;
  let exitCode: number | undefined;
  if (structured) {
    const stdout = asString(structured['stdout']);
    const stderr = asString(structured['stderr']);
    if (stdout !== undefined || stderr !== undefined) {
      output = [stdout, stderr].filter((part) => part !== undefined && part !== '').join('\n');
    }
    const code = structured['exit_code'] ?? structured['exitCode'];
    if (typeof code === 'number' && Number.isInteger(code)) exitCode = code;
  }
  if (output === undefined && Array.isArray(value['content'])) {
    const texts = (value['content'] as unknown[])
      .map((part) => asObject(part))
      .filter((part): part is Json => part !== null && part['type'] === 'text')
      .map((part) => asString(part['text']) ?? '');
    if (texts.length > 0) output = texts.join('\n');
  }
  const ok = value['isError'] !== true && (exitCode === undefined || exitCode === 0);
  const bounded = output === undefined ? null : boundTail(output);
  return {
    k: 'tool_result',
    id,
    ok,
    ...(bounded ? { output: bounded.text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    truncated: bounded?.truncated ?? false,
  };
}

/** Content types that are dropped, never mapped (Q5: reasoning is not shown). */
const DROPPED_CONTENT = new Set(['thinking', 'redactedThinking', 'reasoning']);
/** Stream events that carry nothing for the transcript (progress, model notices). */
const DROPPED_EVENTS = new Set(['notification', 'model_change']);

export function createGooseMapper(): TranscriptMapper {
  let session: string | null = null;
  let complete = false;
  let textCounter = 0;
  let syntheticTextId: string | null = null;

  const textId = (message: Json): string => {
    const id = asString(message['id']);
    if (id) return id;
    syntheticTextId ??= `goose-text-${++textCounter}`;
    return syntheticTextId;
  };

  const mapMessage = (message: Json): TranscriptEvent[] => {
    const role = message['role'];
    const content = Array.isArray(message['content']) ? (message['content'] as unknown[]) : [];
    const events: TranscriptEvent[] = [];
    for (const raw of content) {
      const part = asObject(raw);
      const type = part ? asString(part['type']) : undefined;
      if (!part || !type || DROPPED_CONTENT.has(type)) continue;
      if (type === 'text') {
        // The runner already drew the prompt; a user-role text is goose's echo of it.
        if (role !== 'assistant') continue;
        const delta = asString(part['text']) ?? '';
        if (delta.length > 0) events.push({ k: 'text', id: textId(message), delta });
        continue;
      }
      if (type === 'toolRequest') {
        syntheticTextId = null;
        const id = asString(part['id']) ?? `goose-tool-${++textCounter}`;
        const call = asObject(part['toolCall']);
        const value = call && call['status'] === 'success' ? asObject(call['value']) : null;
        const name = value ? asString(value['name']) : undefined;
        if (value && name) {
          events.push(mapToolCall(id, name, asObject(value['arguments']) ?? {}));
        } else {
          // goose could not parse the model's call; its response says why.
          events.push({ k: 'tool_call', id, kind: 'other', name: 'tool', title: 'tool' });
        }
        continue;
      }
      if (type === 'toolResponse') {
        syntheticTextId = null;
        const id = asString(part['id']) ?? '';
        events.push(mapToolResult(id, asObject(part['toolResult'])));
        continue;
      }
      events.push({ k: 'other', name: otherName(type) });
    }
    return events;
  };

  return {
    onLine(line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      const event = asObject(parsed);
      if (!event) return [];
      // A session id, should a goose version put one on its stream.
      const id = firstString(event, ['session_id', 'sessionId']);
      if (id !== undefined && isSessionId(id)) session = id;
      const type = asString(event['type']);
      if (type === undefined) return [];
      switch (type) {
        case 'message': {
          const message = asObject(event['message']);
          return message ? mapMessage(message) : [];
        }
        case 'complete':
          // Q5/Q10: the token counts it carries are dropped.
          complete = true;
          return [];
        case 'error': {
          const error = asString(event['error']) ?? '';
          // Q6: Stop's own marker; the runner's `stopped` end is the one shown.
          if (error === GOOSE_INTERRUPTED) return [];
          const bounded = boundTail(error, 4 * 1024);
          return [{ k: 'error', code: 'goose_error', ...(error ? { message: bounded.text } : {}) }];
        }
        default:
          if (DROPPED_EVENTS.has(type)) return [];
          return [{ k: 'other', name: otherName(type) }];
      }
    },
    sessionId: () => session,
    sawEnd: () => complete,
    killCode: () => null,
  };
}

// ── The session list (Q7) ───────────────────────────────────────────────────

/** Runs `goose session list --format json` and answers its stdout. */
export type GooseListRunner = (ctx: ChatContext) => Promise<string>;

export const runGooseSessionList: GooseListRunner = (ctx) =>
  new Promise((resolveList, reject) => {
    execFile(
      GOOSE_BINARY,
      ['session', 'list', '--format', 'json'],
      {
        cwd: ctx.cwd,
        env: { ...ctx.env } as NodeJS.ProcessEnv,
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: LIST_MAX_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // The error (which may name a path) is dropped, never logged.
        if (error) reject(new Error('goose session list failed'));
        else resolveList(stdout);
      },
    );
  });

/** A goose time — RFC 3339, `YYYY-MM-DD HH:MM:SS[ UTC]`, or epoch seconds — as ISO 8601. */
export function gooseTime(value: unknown): string | null {
  let ms: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    let text = value.trim().replace(/ UTC$/, 'Z');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text += 'Z';
    ms = Date.parse(text);
  } else {
    return null;
  }
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function samePath(a: string, b: string): boolean {
  const strip = (path: string): string => resolve(path).replace(/\/+$/, '');
  return strip(a) === strip(b);
}

function cutTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= GOOSE_TITLE_CHARS ? title : chars.slice(0, GOOSE_TITLE_CHARS).join('');
}

/** Q7 over goose's listing: `$HOME/workspace` only, newest first, at most `limit`. */
export function parseGooseSessionList(
  stdout: string,
  cwd: string,
  limit: number,
): ChatSessionSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(asObject(parsed)?.['sessions'])
      ? (asObject(parsed)?.['sessions'] as unknown[])
      : [];
  const sessions: (ChatSessionSummary & { at: number })[] = [];
  for (const raw of rows) {
    const row = asObject(raw);
    if (!row) continue;
    const id = asString(row['id']);
    if (id === undefined || !isSessionId(id)) continue;
    const metadata = asObject(row['metadata']) ?? {};
    const dir =
      firstString(row, ['working_dir', 'workingDir']) ?? asString(metadata['working_dir']);
    if (dir === undefined || !samePath(dir, cwd)) continue;
    const updatedAt =
      gooseTime(row['updated_at'] ?? row['updatedAt'] ?? row['modified']) ??
      gooseTime(row['created_at'] ?? row['createdAt']);
    if (updatedAt === null) continue;
    const title =
      firstString(row, ['name', 'description']) ?? asString(metadata['description']) ?? '';
    sessions.push({
      id,
      title: cutTitle(title.trim() || id),
      updatedAt,
      at: Date.parse(updatedAt),
    });
  }
  sessions.sort((a, b) => b.at - a.at);
  return sessions.slice(0, Math.max(0, limit)).map(({ id, title, updatedAt }) => ({
    id,
    title,
    updatedAt,
  }));
}

// ── The adapter ─────────────────────────────────────────────────────────────

export function createGooseAdapter(options: { listSessions?: GooseListRunner } = {}): ChatAdapter {
  const list = options.listSessions ?? runGooseSessionList;
  return {
    profile: 'goose',
    // Q1: goose's stream is supported. Its sign-in cannot be told by a file
    // stat, so the terminal's check answers `unknown`, which Q6 lets through.
    support: async () => ({ supported: true }),
    turnCommand({ prompt, sessionId }): TurnCommand {
      return {
        file: GOOSE_BINARY,
        args: [...GOOSE_RUN_ARGS, ...(sessionId ? ['--resume', '--session-id', sessionId] : [])],
        stdin: prompt,
        env: { ...GOOSE_ENV },
      };
    },
    createMapper: createGooseMapper,
    async listSessions(ctx, limit) {
      return parseGooseSessionList(await list(ctx), ctx.cwd, limit);
    },
    // Q7: goose keeps its messages in `sessions.db`, whose schema it does not
    // document and whose CLI has no documented machine-readable export, so the
    // earlier turns are not drawn. The agent still has them on resume.
    readHistory: async () => ({ unavailable: true }),
  };
}

export const gooseChatAdapter: ChatAdapter = createGooseAdapter();
