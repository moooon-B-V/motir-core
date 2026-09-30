import { spawn as spawnChild } from 'node:child_process';
import type { ChatAdapter, ChatContext, TranscriptMapper } from '../adapter.js';
import {
  boundEvent,
  boundTail,
  isSessionId,
  type ChatSessionSummary,
  type ToolKind,
  type TranscriptEvent,
  type TurnEndReason,
} from '../protocol.js';

// The OpenCode chat adapter (MOTIR-7016 · `docs/decisions/agent-chat.md` Q1's
// `opencode` row, Q3, Q5, Q7, Q11).
//
//   turn     `opencode run --format json --auto [--session <id>] -- <prompt>`
//            The unmodified binary from PATH, no env added (Q11). `--auto` is
//            the sandbox matrix's verified auto-approve flag; the prompt rides
//            argv, as OpenCode's `run` takes it (Q3), after `--` so a prompt
//            that starts with a dash is never read as an option.
//   stream   one JSON object per line: `step_start`, `text`, `tool_use`,
//            `step_finish`, `error` (and `reasoning`), each carrying `sessionID`.
//   end      `step_finish` whose `part.reason` is `"stop"`.
//   Stop     SIGINT (the runner's): exit 130 and no final event, so the turn
//            ends `stopped` from the runner's own record.
//   list     `opencode session list --format json`, OpenCode's own listing of
//            its store (Q7), newest first by `updated`, scoped to `$HOME/workspace`.
//   history  `opencode export <id>`, OpenCode's own dump of a session.
//
// ⚠️ NOTHING HERE LOGS. A line that cannot be mapped is dropped or becomes
// `other`; an `opencode` helper that fails yields an empty list or
// `unavailable`. No error, line or output is ever written anywhere but the
// transcript.

/** The binary, by its bare name (Q11). */
export const OPENCODE_BINARY = 'opencode';
/** Q3's flags for every turn, before the continue form and the prompt. */
export const OPENCODE_TURN_FLAGS: readonly string[] = ['run', '--format', 'json', '--auto'];
/** The pinned version the fixtures were built against (Q1). */
export const OPENCODE_FIXTURE_VERSION = '1.18.33';

/** An inline `error` notice's message is cut to this many characters. */
const MAX_ERROR_MESSAGE_CHARS = 2_000;
/** A helper (`session list`, `export`) is killed after this long. */
const HELPER_TIMEOUT_MS = 20_000;
/** A helper's stdout past this many bytes is refused rather than buffered. */
const HELPER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Run one read-only `opencode` helper and hand back its stdout, or null when it
 * could not start, exited non-zero, timed out or said too much. Injected so the
 * tests replay recorded output instead of a binary.
 */
export type OpencodeExec = (args: string[], ctx: ChatContext) => Promise<string | null>;

/** The real helper: the binary directly (no shell), stdin closed, stderr drained. */
export const execOpencode: OpencodeExec = (args, ctx) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(OPENCODE_BINARY, args, {
        cwd: ctx.cwd,
        // The app's tsconfig widens `ProcessEnv` with required keys (NODE_ENV).
        env: { ...ctx.env } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, HELPER_TIMEOUT_MS);
    timer.unref();
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stderr?.resume();
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > HELPER_MAX_BYTES) {
        child.kill('SIGKILL');
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    // The error may name a path; it is dropped.
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
  });

// ── Reading OpenCode's JSON ─────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The first JSON value in a helper's stdout, skipping any banner before it. */
function parseHelperJson(stdout: string, open: '[' | '{'): unknown {
  const start = stdout.indexOf(open);
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start)) as unknown;
  } catch {
    return undefined;
  }
}

/** Q5's tool kinds, from OpenCode's built-in tool names. */
export function opencodeToolKind(tool: string): ToolKind {
  switch (tool) {
    case 'read':
      return 'read';
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return 'edit';
    case 'bash':
      return 'command';
    default:
      return 'other';
  }
}

/** Where a tool-call's own state stands. */
type ToolStatus = 'pending' | 'running' | 'completed' | 'error';

/**
 * One OpenCode `tool` part → the `tool_call` (once per call id) and, when the
 * call has finished, its `tool_result` (once per call id).
 */
function mapToolPart(
  part: Json,
  seen: { calls: Set<string>; results: Set<string> },
  fallbackId: () => string,
): TranscriptEvent[] {
  const name = str(part['tool']) ?? 'tool';
  const id = str(part['callID']) ?? str(part['id']) ?? fallbackId();
  const state = isObject(part['state']) ? part['state'] : {};
  const status = str(state['status']) as ToolStatus | undefined;
  const input = isObject(state['input']) ? state['input'] : {};
  const metadata = isObject(state['metadata']) ? state['metadata'] : {};
  const kind = opencodeToolKind(name);
  const events: TranscriptEvent[] = [];

  if (!seen.calls.has(id)) {
    seen.calls.add(id);
    const path = str(input['filePath']) ?? str(metadata['filepath']) ?? str(input['path']);
    const command = kind === 'command' ? str(input['command']) : undefined;
    const title = str(state['title']) || command || path || name;
    const call: Extract<TranscriptEvent, { k: 'tool_call' }> = {
      k: 'tool_call',
      id,
      kind,
      name,
      title,
    };
    if (path !== undefined && kind !== 'command') call.path = path;
    if (command !== undefined) call.command = command;
    const diff = kind === 'edit' ? str(metadata['diff']) : undefined;
    if (diff) call.diff = boundTail(diff).text;
    events.push(call);
  }

  if ((status === 'completed' || status === 'error') && !seen.results.has(id)) {
    seen.results.add(id);
    if (status === 'error') {
      const bounded = boundTail(str(state['error']) ?? '');
      events.push({
        k: 'tool_result',
        id,
        ok: false,
        output: bounded.text,
        truncated: bounded.truncated,
      });
    } else {
      const exitCode = kind === 'command' ? num(metadata['exit']) : undefined;
      const output =
        str(state['output']) ?? (kind === 'command' ? str(metadata['output']) : undefined);
      const result: Extract<TranscriptEvent, { k: 'tool_result' }> = {
        k: 'tool_result',
        id,
        // A command that exited non-zero is drawn failed; anything else completed ran.
        ok: exitCode === undefined || exitCode === 0,
        truncated: false,
      };
      if (output !== undefined) {
        const bounded = boundTail(output);
        result.output = bounded.text;
        result.truncated = bounded.truncated;
      }
      if (exitCode !== undefined) result.exitCode = exitCode;
      events.push(result);
    }
  }
  return events;
}

/** An OpenCode error object (`{ name, data: { message } }`) → Q5's inline notice. */
function mapError(error: unknown): TranscriptEvent {
  const value = isObject(error) ? error : {};
  const data = isObject(value['data']) ? value['data'] : {};
  const code = str(value['name']) || 'error';
  const message = str(data['message']) ?? str(value['message']);
  const event: Extract<TranscriptEvent, { k: 'error' }> = { k: 'error', code };
  if (message) event.message = Array.from(message).slice(0, MAX_ERROR_MESSAGE_CHARS).join('');
  return event;
}

// ── The mapper (Q5) ─────────────────────────────────────────────────────────

/**
 * A fresh mapper for one turn of `opencode run --format json`.
 *
 *   step_start                 dropped (a model step began)
 *   text                       `text`, one complete message per part id
 *   tool_use                   `tool_call` + `tool_result` by the tool's kind
 *   step_finish                dropped, tokens and cost with it (Q5, Q10);
 *                              `part.reason: "stop"` is the end marker
 *   reasoning                  dropped (Q5)
 *   error                      an inline `error` notice
 *   any other `type`           `other`, named by the type
 *   not JSON, or no `type`     dropped
 */
export function createOpencodeMapper(): TranscriptMapper {
  let session: string | null = null;
  let ended = false;
  let counter = 0;
  const seen = { calls: new Set<string>(), results: new Set<string>() };
  const texts = new Set<string>();
  const fallbackId = (): string => `opencode-${++counter}`;

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
      const sessionID = str(value['sessionID']);
      if (session === null && sessionID !== undefined && isSessionId(sessionID))
        session = sessionID;
      const part = isObject(value['part']) ? value['part'] : {};

      switch (type) {
        case 'step_start':
        case 'reasoning':
          return [];
        case 'step_finish':
          if (str(part['reason']) === 'stop') ended = true;
          return [];
        case 'text': {
          const text = str(part['text']);
          if (!text) return [];
          const id = str(part['id']) ?? fallbackId();
          if (texts.has(id)) return [];
          texts.add(id);
          return [{ k: 'text', id, delta: text }];
        }
        case 'tool_use':
          return mapToolPart(part, seen, fallbackId).map(boundEvent);
        case 'error':
          return [mapError(value['error'])];
        default:
          return [{ k: 'other', name: type }];
      }
    },
    sessionId: () => session,
    sawEnd: () => ended,
    killCode: () => null,
  };
}

// ── The session list and history (Q7) ──────────────────────────────────────

/**
 * `opencode session list --format json` → Q7's rows: sessions of this working
 * directory, newest first by `updated`, at most `limit`, titled by OpenCode's
 * own title.
 */
export function parseOpencodeSessionList(
  stdout: string,
  cwd: string,
  limit: number,
): ChatSessionSummary[] {
  const value = parseHelperJson(stdout, '[');
  if (!Array.isArray(value)) return [];
  const rows: { id: string; title: string; updated: number }[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = str(entry['id']);
    const updated = num(entry['updated']) ?? num(entry['created']);
    if (!id || !isSessionId(id) || updated === undefined) continue;
    const directory = str(entry['directory']);
    if (directory !== undefined && directory !== cwd) continue;
    rows.push({ id, title: str(entry['title']) || id, updated });
  }
  rows.sort((a, b) => b.updated - a.updated);
  return rows.slice(0, Math.max(0, limit)).map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: new Date(row.updated).toISOString(),
  }));
}

/** How an exported assistant message ended. */
function turnEndOf(info: Json): TurnEndReason {
  const error = isObject(info['error']) ? info['error'] : null;
  if (!error) return 'completed';
  return str(error['name']) === 'MessageAbortedError' ? 'stopped' : 'failed';
}

/**
 * `opencode export <id>` → Q7's history: each earlier turn as the user's prompt,
 * its mapped parts and a `turn_end`, keeping the NEWEST turns within
 * `budgetBytes`. Null when the export cannot be read.
 */
export function parseOpencodeExport(
  stdout: string,
  budgetBytes: number,
): { events: TranscriptEvent[]; truncated: boolean } | null {
  const value = parseHelperJson(stdout, '{');
  if (!isObject(value) || !Array.isArray(value['messages'])) return null;
  const turns: TranscriptEvent[][] = [];
  let current: TranscriptEvent[] | null = null;
  let end: TurnEndReason = 'completed';
  let counter = 0;
  const seen = { calls: new Set<string>(), results: new Set<string>() };
  const fallbackId = (): string => `opencode-history-${++counter}`;
  const close = (): void => {
    if (current) {
      current.push({ k: 'turn_end', reason: end });
      turns.push(current);
    }
    current = null;
    end = 'completed';
  };

  for (const message of value['messages']) {
    if (!isObject(message)) continue;
    const info = isObject(message['info']) ? message['info'] : {};
    const parts = Array.isArray(message['parts']) ? message['parts'] : [];
    const role = str(info['role']);
    if (role === 'user') {
      close();
      const text = parts
        .filter(isObject)
        .filter((part) => str(part['type']) === 'text' && part['synthetic'] !== true)
        .map((part) => str(part['text']) ?? '')
        .join('\n');
      current = [{ k: 'user', text }];
    } else if (role === 'assistant') {
      current ??= [];
      end = turnEndOf(info);
      for (const part of parts) {
        if (!isObject(part)) continue;
        const type = str(part['type']);
        if (type === 'text') {
          const text = str(part['text']);
          if (text) current.push({ k: 'text', id: str(part['id']) ?? fallbackId(), delta: text });
        } else if (type === 'tool') {
          current.push(...mapToolPart(part, seen, fallbackId).map(boundEvent));
        }
      }
    }
  }
  close();

  const kept: TranscriptEvent[][] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const size = turn.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      0,
    );
    if (bytes + size > budgetBytes) break;
    bytes += size;
    kept.unshift(turn);
  }
  return { events: kept.flat(), truncated: kept.length < turns.length };
}

// ── The adapter ─────────────────────────────────────────────────────────────

export function createOpencodeAdapter(exec: OpencodeExec = execOpencode): ChatAdapter {
  return {
    profile: 'opencode',

    // Q1: OpenCode streams, on any sign-in (Q2 names no term against it). The
    // terminal's sign-in check still gates each turn, in the runner.
    async support() {
      return { supported: true };
    },

    turnCommand({ prompt, sessionId }) {
      return {
        file: OPENCODE_BINARY,
        args: [
          ...OPENCODE_TURN_FLAGS,
          ...(sessionId !== null ? ['--session', sessionId] : []),
          '--',
          prompt,
        ],
        stdin: null,
      };
    },

    createMapper: createOpencodeMapper,

    async listSessions(ctx, limit) {
      const stdout = await exec(['session', 'list', '--format', 'json'], ctx);
      return stdout === null ? [] : parseOpencodeSessionList(stdout, ctx.cwd, limit);
    },

    async readHistory(ctx, sessionId, budgetBytes) {
      if (!isSessionId(sessionId)) return { unavailable: true };
      const stdout = await exec(['export', sessionId], ctx);
      const history = stdout === null ? null : parseOpencodeExport(stdout, budgetBytes);
      return history ?? { unavailable: true };
    },
  };
}

export const opencodeChatAdapter: ChatAdapter = createOpencodeAdapter();
