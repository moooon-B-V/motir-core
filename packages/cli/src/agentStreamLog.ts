import {
  resolveChatAdapter,
  type ChatAdapter,
  type TranscriptMapper,
} from './agentTerminal/chat/adapter.js';
import type { TranscriptEvent } from './agentTerminal/chat/protocol.js';
import { homedir } from 'node:os';

// READABLE LINES FROM AN AGENT'S EVENT STREAM (MOTIR-8980).
//
// A run in the developer's own agent launches the agent in its STREAMING mode
// (`agentProfiles.ts` `agentStream`), so its stdout is a JSON event stream, one object
// per line — the stream the Chat tab already reads. Nobody is meant to read that: the
// run modal's Agent output and the developer's terminal both want what the agent DID.
// This turns the stream into those lines using the profile's own chat adapter mapper,
// so there is one parser per profile and a stream format it learns is learned here too.
//
// ⚠️ NEVER RAW JSON. A line that parses as an event and maps to nothing the log draws
// (a rate-limit notice, a lifecycle marker) is DROPPED, not passed through; only a line
// that is not an event at all (a banner, a plain-text warning) is written as it came.
// A half-line is held until its newline, so a chunk boundary mid-object cannot leak.

/** A tool call's own title is cut to this many characters — a long shell command or path. */
const MAX_TITLE_CHARS = 200;

export interface AgentStreamFormatter {
  /** Take a chunk of the agent's stdout; returns the readable text it completed ('' if none). */
  write(chunk: string): string;
  /** The text still held back — call once, when the stream ends. */
  flush(): string;
  /** The agent's own session id, once the stream has revealed it. */
  sessionId(): string | null;
}

/**
 * The formatter for `profileId`'s stream, or null when no chat adapter reads it (the
 * caller then passes the agent's output through untouched).
 */
export function createAgentStreamFormatter(
  profileId: string,
  adapter: ChatAdapter | null = resolveChatAdapter(profileId),
): AgentStreamFormatter | null {
  if (!adapter) return null;
  const mapper = adapter.createMapper();
  return createFormatter(mapper);
}

function createFormatter(mapper: TranscriptMapper): AgentStreamFormatter {
  /** The part of the current stdout line that has not seen its newline yet. */
  let partial = '';
  /** The id of the assistant text whose line is still open (a delta stream), or null. */
  let openText: string | null = null;

  const closeText = (): string => {
    if (openText === null) return '';
    openText = null;
    return '\n';
  };

  const render = (event: TranscriptEvent): string => {
    switch (event.k) {
      case 'text': {
        if (event.delta === '') return '';
        let out = '';
        if (openText !== null && openText !== event.id) out += closeText();
        out += event.delta;
        openText = event.delta.endsWith('\n') ? null : event.id;
        return out;
      }
      case 'tool_call':
        return closeText() + `${toolLine(event)}\n`;
      case 'tool_result':
        // A tool that worked is its call line; one that failed says so.
        return event.ok ? '' : closeText() + `  ✗ failed${exit(event.exitCode)}\n`;
      case 'error':
        return (
          closeText() +
          `error: ${event.code}${event.message ? ` — ${oneLine(event.message)}` : ''}\n`
        );
      default:
        // `user`, `turn_end` and `other` carry nothing a log line is for.
        return '';
    }
  };

  const onLine = (line: string): string => {
    if (line.trim() === '') return '';
    // Not an event at all — a banner or a plain warning. Written as it came.
    if (!line.trimStart().startsWith('{')) return closeText() + `${line}\n`;
    let events: TranscriptEvent[];
    try {
      events = mapper.onLine(line);
    } catch {
      // A mapper that cannot read a line has not understood it; raw JSON is not the fallback.
      return '';
    }
    return events.map(render).join('');
  };

  return {
    write(chunk) {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      return lines.map((line) => onLine(line.replace(/\r$/, ''))).join('');
    },
    flush() {
      const rest = partial;
      partial = '';
      return onLine(rest) + closeText();
    },
    sessionId: () => mapper.sessionId(),
  };
}

function toolLine(event: Extract<TranscriptEvent, { k: 'tool_call' }>): string {
  if (event.kind === 'command') {
    const command = event.command ?? event.title;
    return `Bash: ${cut(oneLine(command))}`;
  }
  const subject = event.path ?? event.title;
  const verb = event.kind === 'edit' ? 'Edit' : event.kind === 'read' ? 'Read' : event.name;
  return subject === verb || subject === '' ? verb : `${verb} ${cut(oneLine(subject))}`;
}

function exit(code: number | undefined): string {
  return code === undefined ? '' : ` (exit ${code})`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cut(text: string): string {
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}

/**
 * The id of the session the agent just ran, read from the agent's OWN session store, for
 * a profile whose stream never said (goose prints none in its recordings). The newest
 * session in the run's checkout that was touched at or after `since` — a run has a
 * checkout of its own, so two runs do not share a list. Null when there is none, the
 * profile has no adapter, or the store cannot be read: an unknown id is better than a
 * guessed one, because a later fix would resume whatever it names.
 */
export async function lookupSessionId(
  profileId: string,
  ctx: { cwd: string; env: NodeJS.ProcessEnv },
  since: number,
  adapter: ChatAdapter | null = resolveChatAdapter(profileId),
): Promise<string | null> {
  if (!adapter) return null;
  try {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(ctx.env)) if (value !== undefined) env[name] = value;
    const sessions = await adapter.listSessions(
      { home: env['HOME'] ?? homedir(), cwd: ctx.cwd, env },
      5,
    );
    const fresh = sessions.find((session) => Date.parse(session.updatedAt) >= since);
    return fresh?.id ?? null;
  } catch {
    return null;
  }
}
