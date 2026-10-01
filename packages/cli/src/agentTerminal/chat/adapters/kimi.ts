import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// Types only: `adapter.ts` imports this file to register it, so a value import
// back would make the two modules' evaluation order matter.
import type {
  ChatAdapter,
  ChatContext,
  ChatSupport,
  TranscriptMapper,
  TurnCommand,
} from '../adapter.js';
import {
  boundTail,
  type ChatSessionSummary,
  type ToolKind,
  type TranscriptEvent,
} from '../protocol.js';

// The kimi chat adapter (MOTIR-7034 · `docs/decisions/agent-chat.md` Q1's
// `kimi` row, Q3, Q5, Q6, Q7, Q10, Q11).
//
//   headless   `kimi -p <prompt> --output-format stream-json` — the prompt on
//              argv (Q3); `-p` already runs under the auto permission policy,
//              so no permission flag and no environment variable is added.
//   resume     the same, plus `--session <id>`.
//   turn end   the `{"role":"meta","type":"session.resume_hint"}` line, which
//              also names the session id — so a new chat's id is known only at
//              the END of its first turn (Q7). A stopped turn (SIGINT, exit
//              130) prints no hint; the runner ends it `stopped` regardless.
//   stream     one line per COMPLETE message, in the OpenAI chat-message shape:
//              `{"role":"assistant","content"?,"tool_calls"?}`,
//              `{"role":"tool","tool_call_id","content"}`, `{"role":"meta",…}`.
//              Replies arrive whole, not word by word (Q1).
//   stderr     kimi writes tool progress there. The runner drains and discards
//              it (Q10); nothing here reads it.
//   sessions   `$KIMI_CODE_HOME/sessions/session_index.jsonl` (default home
//              `~/.kimi-code`), one row per session, with its working
//              directory. Read, never written; nothing is copied to Motir.
//   history    the transcript lives in `wire.jsonl` under a per-directory,
//              per-session tree whose record shape kimi does not document, so
//              `readHistory` answers `unavailable` (Q7): the tab shows the
//              resumed session with no earlier turns drawn; kimi still has them.
//
// ⚠️ NOTHING HERE LOGS. A line the mapper does not recognise becomes `other`
// (named by its `type`) or is dropped; it never ends the turn (Q5, Q10).

export const KIMI_BINARY = 'kimi';

/** Q7's title bound (`adapter.ts` `MAX_TITLE_CHARS`; the runner cuts again). */
const MAX_TITLE_CHARS = 120;

/** Tool names, by Q5 kind. kimi's own names first; the capture's `Bash` too. */
const COMMAND_TOOLS = new Set(['Bash', 'Shell', 'bash', 'shell', 'run_shell_command']);
const READ_TOOLS = new Set(['ReadFile', 'Read', 'read_file', 'ReadMediaFile']);
const EDIT_TOOLS = new Set([
  'WriteFile',
  'StrReplaceFile',
  'Write',
  'Edit',
  'MultiEdit',
  'write_file',
  'str_replace_file',
]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toolKind(name: string): ToolKind {
  if (COMMAND_TOOLS.has(name)) return 'command';
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  return 'other';
}

/** A tool call's `function.arguments`: a JSON string in the stream, an object tolerated. */
function parseArguments(value: unknown): Json {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A message's `content`: a string, or a list of parts of which only `text` is kept (thinking dropped, Q5). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (isObject(part) && part['type'] === 'text') text += str(part['text']) ?? '';
  }
  return text;
}

function lines(text: string): string[] {
  if (text.length === 0) return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * kimi's stream carries an edit's INPUT, not a diff. The row's diff is drawn
 * from it: the replaced text as `-` lines and its replacement as `+`, one hunk
 * per replacement; a whole-file write is all `+`.
 */
function editDiff(args: Json, path: string | undefined): string | undefined {
  const file = path ?? 'file';
  const hunks: string[] = [];
  const replacement = (edit: Json): void => {
    const oldText = str(edit['old']) ?? str(edit['old_string']) ?? str(edit['old_str']);
    const newText = str(edit['new']) ?? str(edit['new_string']) ?? str(edit['new_str']);
    if (oldText === undefined || newText === undefined) return;
    hunks.push(
      ['@@ @@', ...lines(oldText).map((l) => `-${l}`), ...lines(newText).map((l) => `+${l}`)].join(
        '\n',
      ),
    );
  };
  const edits = args['edit'] ?? args['edits'];
  if (Array.isArray(edits)) {
    for (const edit of edits) if (isObject(edit)) replacement(edit);
  } else if (isObject(edits)) {
    replacement(edits);
  } else {
    replacement(args);
  }
  const content = str(args['content']);
  if (hunks.length === 0 && content !== undefined) {
    hunks.push(['@@ @@', ...lines(content).map((l) => `+${l}`)].join('\n'));
  }
  if (hunks.length === 0) return undefined;
  return boundTail(`--- a/${file}\n+++ b/${file}\n${hunks.join('\n')}\n`).text;
}

/** `<system>…</system>` notes kimi appends to a tool's output: kept out of the output, read for the outcome. */
const SYSTEM_NOTE = /<system>([\s\S]*?)<\/system>/g;

function toolOutcome(content: string): { ok: boolean; output: string; exitCode?: number } {
  const notes: string[] = [];
  const output = content.replace(SYSTEM_NOTE, (_match, note: string) => {
    notes.push(note);
    return '';
  });
  const failed = notes.some((note) => /^\s*ERROR\b/i.test(note));
  const exit = notes.map((note) => /exit code:?\s*(-?\d+)/i.exec(note)).find((m) => m != null);
  // A failure with no output of its own shows its reason as the output.
  const shown =
    output.trim().length > 0 ? output : failed ? notes.map((n) => n.trim()).join('\n') : '';
  return { ok: !failed, output: shown, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
}

/** Q5: kimi's stream-json lines → transcript events. A fresh one per turn. */
export function createKimiMapper(): TranscriptMapper {
  let session: string | null = null;
  let ended = false;
  let messages = 0;

  const toolCall = (value: unknown): TranscriptEvent | null => {
    if (!isObject(value)) return null;
    const id = str(value['id']);
    const fn = isObject(value['function']) ? value['function'] : null;
    const name = fn ? str(fn['name']) : undefined;
    if (!id || !name || !fn) return null;
    const args = parseArguments(fn['arguments']);
    const kind = toolKind(name);
    const path = str(args['path']) ?? str(args['file_path']);
    if (kind === 'command') {
      const command = str(args['command']) ?? '';
      return { k: 'tool_call', id, kind, name, title: command || name, command };
    }
    if (kind === 'read') {
      return { k: 'tool_call', id, kind, name, title: path ?? name, ...(path ? { path } : {}) };
    }
    if (kind === 'edit') {
      const diff = editDiff(args, path);
      return {
        k: 'tool_call',
        id,
        kind,
        name,
        title: path ?? name,
        ...(path ? { path } : {}),
        ...(diff !== undefined ? { diff } : {}),
      };
    }
    return { k: 'tool_call', id, kind, name, title: name, ...(path ? { path } : {}) };
  };

  const onLine = (line: string): TranscriptEvent[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return []; // Not JSON: dropped (Q5).
    }
    if (!isObject(parsed)) return [];
    const role = str(parsed['role']);
    const type = str(parsed['type']);
    switch (role) {
      case 'assistant': {
        const events: TranscriptEvent[] = [];
        const text = contentText(parsed['content']);
        if (text.length > 0) events.push({ k: 'text', id: `kimi-msg-${++messages}`, delta: text });
        const toolCalls = parsed['tool_calls'];
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const event = toolCall(call);
            if (event) events.push(event);
          }
        }
        return events;
      }
      case 'tool': {
        const id = str(parsed['tool_call_id']);
        if (!id) return type ? [{ k: 'other', name: type }] : [];
        const outcome = toolOutcome(contentText(parsed['content']));
        const explicitError = parsed['is_error'] === true;
        const bounded = boundTail(outcome.output);
        return [
          {
            k: 'tool_result',
            id,
            ok: outcome.ok && !explicitError,
            ...(bounded.text.length > 0 ? { output: bounded.text } : {}),
            ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
            truncated: bounded.truncated,
          },
        ];
      }
      case 'meta': {
        if (type === 'session.resume_hint') {
          const id = str(parsed['session_id']);
          if (id) session = id;
          ended = true;
          return [];
        }
        // The version banner carries nothing to draw.
        if (type === 'system.version') return [];
        return type ? [{ k: 'other', name: type }] : [];
      }
      case 'user':
      case 'system':
        // The prompt is the runner's `user` event; a system prompt is not drawn.
        return [];
      default:
        return type ? [{ k: 'other', name: type }] : [];
    }
  };

  return {
    onLine,
    sessionId: () => session,
    sawEnd: () => ended,
    killCode: () => null,
  };
}

// ── The session store (Q7) ──────────────────────────────────────────────────

/** kimi's data home: `$KIMI_CODE_HOME`, else `~/.kimi-code`. Read only. */
export function kimiHome(ctx: ChatContext): string {
  const configured = ctx.env['KIMI_CODE_HOME']?.trim();
  return configured ? configured : join(ctx.home, '.kimi-code');
}

/** Where the index is read from, first found wins. */
export function sessionIndexPaths(ctx: ChatContext): string[] {
  const home = kimiHome(ctx);
  return [join(home, 'sessions', 'session_index.jsonl'), join(home, 'session_index.jsonl')];
}

function firstString(row: Json, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = str(row[name]);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** An index time: epoch seconds, epoch milliseconds, or an ISO string. */
function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return parseTime(numeric);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function cutTitle(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  return chars.length <= MAX_TITLE_CHARS
    ? chars.join('')
    : chars.slice(0, MAX_TITLE_CHARS).join('');
}

/**
 * Q7's list from the index text: rows whose working directory is `cwd`, the
 * latest row per id (the index is appended to), newest first, at most `limit`.
 */
export function parseSessionIndex(text: string, cwd: string, limit: number): ChatSessionSummary[] {
  const scope = resolve(cwd);
  const latest = new Map<string, { title: string; at: number }>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(row)) continue;
    const id = firstString(row, ['session_id', 'id']);
    const dir = firstString(row, ['work_dir', 'workdir', 'cwd', 'working_directory', 'path']);
    if (!id || !dir || resolve(dir) !== scope) continue;
    const at =
      parseTime(row['updated_at']) ??
      parseTime(row['updated']) ??
      parseTime(row['last_updated']) ??
      parseTime(row['created_at']);
    if (at === null) continue;
    const title = firstString(row, ['title', 'first_prompt', 'summary']) ?? id;
    const previous = latest.get(id);
    if (!previous || at >= previous.at) latest.set(id, { title, at });
  }
  return [...latest.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, Math.max(0, limit))
    .map(([id, { title, at }]) => ({
      id,
      title: cutTitle(title),
      updatedAt: new Date(at).toISOString(),
    }));
}

export const kimiAdapter: ChatAdapter = {
  profile: 'kimi',

  // Q1: supported. kimi's sign-in cannot be told by a file stat, so the
  // terminal's check reads `unknown`, which Q6 lets through; there is no
  // sign-in rule of Q2's kind for kimi.
  async support(): Promise<ChatSupport> {
    return { supported: true };
  },

  // Q3 exactly: the prompt on argv, no permission flag (`-p` is already auto),
  // no environment addition (Q11).
  turnCommand({ prompt, sessionId }): TurnCommand {
    return {
      file: KIMI_BINARY,
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        ...(sessionId !== null ? ['--session', sessionId] : []),
      ],
      stdin: null,
    };
  },

  createMapper: createKimiMapper,

  async listSessions(ctx, limit) {
    for (const path of sessionIndexPaths(ctx)) {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue; // No index there. The error (a path) is not logged.
      }
      return parseSessionIndex(text, ctx.cwd, limit);
    }
    return [];
  },

  async readHistory() {
    return { unavailable: true };
  },
};
