// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_CLIENT_FRAME_TYPES,
  CHAT_ERROR_CODES,
  CHAT_PING_ACTIVE,
  CHAT_PING_INACTIVE,
  CHAT_PONG,
  CHAT_SERVER_FRAME_TYPES,
  CHAT_SIGN_IN_STATES,
  MAX_PROMPT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  TOOL_KINDS,
  TRANSCRIPT_EVENT_KINDS,
  TURN_END_REASONS,
  TURN_FAIL_CODES,
  isTranscriptEvent,
  parseChatServerFrame,
} from '@/lib/agentChat/protocol';
import * as relay from '@/lib/agentTerminal/protocol';

// THE BROWSER'S CHAT PROTOCOL AGREES WITH THE CLI'S (Story MOTIR-6863 ·
// MOTIR-7017). `lib/agentChat/protocol.ts` is a MIRROR of
// `packages/cli/src/agentTerminal/chat/protocol.ts` — the web app may not import
// the CLI package — so this suite reads the CLI file's SOURCE TEXT and fails when
// either side gains a frame, an event kind, a tool kind, a turn-end reason, a
// fail code or an error code the other lacks.

const REPO = join(__dirname, '..', '..');
const CLI_CHAT = readFileSync(
  join(REPO, 'packages', 'cli', 'src', 'agentTerminal', 'chat', 'protocol.ts'),
  'utf8',
);
const CLI_TERMINAL = readFileSync(
  join(REPO, 'packages', 'cli', 'src', 'agentTerminal', 'protocol.ts'),
  'utf8',
);

/** The source of `export type <name> = …;` (up to the first `;` at depth 0). */
function typeBlock(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} =`);
  if (start === -1) throw new Error(`the CLI protocol has no type ${name}`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '<') depth += 1;
    else if (ch === '}' || ch === ')' || ch === '>') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i);
  }
  throw new Error(`unterminated type ${name}`);
}

/** Every `'literal'` in a block. */
const literals = (block: string): string[] => [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

/** Every `<field>: '<literal>'` in a block — the union's discriminants. */
const discriminants = (block: string, field: string): string[] =>
  [...block.matchAll(new RegExp(`\\b${field}: '([a-z_]+)'`, 'g'))].map((m) => m[1]!);

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe('the mirror agrees with packages/cli chat/protocol.ts', () => {
  it('client frames', () => {
    expect(sorted(discriminants(typeBlock(CLI_CHAT, 'ChatClientFrame'), 't'))).toEqual(
      sorted(CHAT_CLIENT_FRAME_TYPES),
    );
  });

  it('server frames', () => {
    expect(sorted(discriminants(typeBlock(CLI_CHAT, 'ChatServerFrame'), 't'))).toEqual(
      sorted(CHAT_SERVER_FRAME_TYPES),
    );
  });

  it('transcript event kinds', () => {
    expect(sorted(discriminants(typeBlock(CLI_CHAT, 'TranscriptEvent'), 'k'))).toEqual(
      sorted(TRANSCRIPT_EVENT_KINDS),
    );
  });

  it('error codes', () => {
    expect(sorted(literals(typeBlock(CLI_CHAT, 'ChatErrorCode')))).toEqual(
      sorted(CHAT_ERROR_CODES),
    );
  });

  it('tool kinds, turn-end reasons and the runner’s fail codes', () => {
    expect(sorted(literals(typeBlock(CLI_CHAT, 'ToolKind')))).toEqual(sorted(TOOL_KINDS));
    expect(sorted(literals(typeBlock(CLI_CHAT, 'TurnEndReason')))).toEqual(
      sorted(TURN_END_REASONS),
    );
    expect(sorted(literals(typeBlock(CLI_CHAT, 'TurnFailCode')))).toEqual(sorted(TURN_FAIL_CODES));
  });

  it('the sign-in states the hello and signin frames carry', () => {
    expect(sorted(literals(typeBlock(CLI_TERMINAL, 'SignInState')))).toEqual(
      sorted(CHAT_SIGN_IN_STATES),
    );
  });

  it('the byte bounds', () => {
    expect(CLI_CHAT).toMatch(/export const MAX_PROMPT_BYTES = 64 \* 1024;/);
    expect(CLI_CHAT).toMatch(/export const MAX_TOOL_OUTPUT_BYTES = 64 \* 1024;/);
    expect(MAX_PROMPT_BYTES).toBe(64 * 1024);
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(64 * 1024);
  });

  it('the guard is not vacuous: an extra frame on either side is seen', () => {
    const cliWithExtra = typeBlock(CLI_CHAT, 'ChatServerFrame') + "\n  | { t: 'surprise' }";
    expect(sorted(discriminants(cliWithExtra, 't'))).not.toEqual(sorted(CHAT_SERVER_FRAME_TYPES));
    expect(sorted(discriminants(typeBlock(CLI_CHAT, 'ChatServerFrame'), 't'))).not.toEqual(
      sorted([...CHAT_SERVER_FRAME_TYPES, 'surprise']),
    );
  });
});

describe('the heartbeat bytes are the relay’s own', () => {
  it('re-exports the relay constants, byte for byte', () => {
    expect(CHAT_PING_ACTIVE).toBe(relay.CHAT_PING_ACTIVE);
    expect(CHAT_PING_INACTIVE).toBe(relay.CHAT_PING_INACTIVE);
    expect(CHAT_PONG).toBe(relay.CHAT_PONG);
    expect(CHAT_PING_ACTIVE).toBe('{"t":"ping","active":true}');
    expect(CHAT_PING_INACTIVE).toBe('{"t":"ping","active":false}');
  });
});

describe('parsing what the server sends', () => {
  it('reads every server frame the CLI can encode', () => {
    const frames = [
      {
        t: 'hello',
        profile: 'claude',
        supported: false,
        reason: 'subscription_signin',
        signin: 'signed_in',
      },
      { t: 'sessions', items: [{ id: 's1', title: 'x', updatedAt: '2026-09-30T10:00:00Z' }] },
      { t: 'ready', session: null, resumed: false },
      { t: 'history', events: [{ k: 'user', text: 'hi' }], truncated: false },
      { t: 'session', id: 's1' },
      { t: 'event', turn: 1, e: { k: 'text', id: 'm1', delta: 'hello' } },
      { t: 'pong' },
      { t: 'signin', profile: 'claude', state: 'signed_out' },
      { t: 'error', code: 'turn_running' },
    ];
    expect(sorted(frames.map((f) => f.t))).toEqual(sorted(CHAT_SERVER_FRAME_TYPES));
    for (const f of frames) expect(parseChatServerFrame(JSON.stringify(f))).toEqual(f);
  });

  it('drops what it does not know, silently', () => {
    expect(parseChatServerFrame('not json')).toBeNull();
    expect(parseChatServerFrame('{"t":"surprise"}')).toBeNull();
    expect(parseChatServerFrame('{"t":"error","code":"made_up"}')).toBeNull();
    expect(parseChatServerFrame('{"t":"event","turn":1,"e":{"k":"thinking"}}')).toBeNull();
    // A history keeps the events it can draw and drops the rest.
    expect(
      parseChatServerFrame(
        JSON.stringify({
          t: 'history',
          events: [{ k: 'x' }, { k: 'other', name: 'y' }],
          truncated: true,
        }),
      ),
    ).toEqual({ t: 'history', events: [{ k: 'other', name: 'y' }], truncated: true });
  });

  it('knows every event kind', () => {
    const events = [
      { k: 'user', text: 'a' },
      { k: 'text', id: '1', delta: 'b' },
      {
        k: 'tool_call',
        id: 't',
        kind: 'edit',
        name: 'Edit',
        title: 'Edit a.ts',
        path: 'a.ts',
        diff: '+x',
      },
      { k: 'tool_result', id: 't', ok: true, output: 'ok', exitCode: 0, truncated: false },
      { k: 'turn_end', reason: 'failed', code: 'exit_nonzero' },
      { k: 'error', code: 'retry', message: 'm' },
      { k: 'other', name: 'n' },
    ];
    expect(sorted(events.map((e) => e.k))).toEqual(sorted(TRANSCRIPT_EVENT_KINDS));
    for (const e of events) expect(isTranscriptEvent(e)).toBe(true);
  });
});
