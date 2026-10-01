// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isTranscriptEvent, parseChatServerFrame } from '@/lib/agentChat/protocol';

// THE BROWSER'S CHAT FRAME READER, at its edges (Story MOTIR-6863 · MOTIR-7018,
// `docs/decisions/agent-chat.md` Q4, Q10). The story gate hands the tab only the
// frames a real server writes; this file holds what the reader does with a frame
// no server should write — it is dropped (null), or its optional parts fall back,
// and nothing is thrown or logged.

const parse = (value: unknown) => parseChatServerFrame(JSON.stringify(value));

describe('isTranscriptEvent', () => {
  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'text', 7, [], [{ k: 'user', text: 'x' }]]) {
      expect(isTranscriptEvent(value)).toBe(false);
    }
  });

  it('refuses an unknown kind and a known kind missing its fields', () => {
    expect(isTranscriptEvent({ k: 'usage', tokens: 3 })).toBe(false);
    expect(isTranscriptEvent({ k: 'user' })).toBe(false);
    expect(
      isTranscriptEvent({ k: 'tool_call', id: 'c', kind: 'shell', name: 'x', title: 'x' }),
    ).toBe(false);
    expect(
      isTranscriptEvent({ k: 'tool_result', id: 'c', ok: true, exitCode: '0', truncated: false }),
    ).toBe(false);
    expect(isTranscriptEvent({ k: 'turn_end', reason: 'done' })).toBe(false);
  });
});

describe('parseChatServerFrame', () => {
  it('drops text that is not JSON, and JSON that is not an object', () => {
    expect(parseChatServerFrame('{not json')).toBeNull();
    expect(parseChatServerFrame('[1,2]')).toBeNull();
    expect(parseChatServerFrame('"hello"')).toBeNull();
    expect(parse({ t: 'nope' })).toBeNull();
  });

  it('hello: drops one with no boolean supported; an unknown sign-in reads unknown; an unknown reason is left out', () => {
    expect(parse({ t: 'hello', supported: 'yes' })).toBeNull();
    expect(parse({ t: 'hello', profile: 7, supported: true, signin: 'maybe' })).toEqual({
      t: 'hello',
      profile: null,
      supported: true,
      signin: 'unknown',
    });
    expect(
      parse({
        t: 'hello',
        profile: 'codex',
        supported: false,
        reason: 'broken',
        signin: 'signed_out',
      }),
    ).toEqual({ t: 'hello', profile: 'codex', supported: false, signin: 'signed_out' });
    expect(
      parse({
        t: 'hello',
        profile: 'aider',
        supported: false,
        reason: 'unsupported',
        signin: 'unknown',
      }),
    ).toEqual({
      t: 'hello',
      profile: 'aider',
      supported: false,
      reason: 'unsupported',
      signin: 'unknown',
    });
  });

  it('sessions and history: drop a frame whose list is not a list, and filter what is not a session or an event', () => {
    expect(parse({ t: 'sessions', items: 'x' })).toBeNull();
    expect(
      parse({
        t: 'sessions',
        items: [{ id: 's', title: 'T', updatedAt: 'u' }, { id: 's2' }, null],
      }),
    ).toEqual({ t: 'sessions', items: [{ id: 's', title: 'T', updatedAt: 'u' }] });
    expect(parse({ t: 'history', events: {} })).toBeNull();
    expect(
      parse({ t: 'history', events: [{ k: 'user', text: 'hi' }, { k: 'usage' }], truncated: 1 }),
    ).toEqual({ t: 'history', events: [{ k: 'user', text: 'hi' }], truncated: false });
  });

  it('ready, session, event, signin and error: each drops or falls back on a malformed part', () => {
    expect(parse({ t: 'ready', session: 5, resumed: 'yes' })).toEqual({
      t: 'ready',
      session: null,
      resumed: false,
    });
    expect(parse({ t: 'session' })).toBeNull();
    expect(parse({ t: 'session', id: 's' })).toEqual({ t: 'session', id: 's' });
    expect(parse({ t: 'event', turn: '1', e: { k: 'user', text: 'x' } })).toBeNull();
    expect(parse({ t: 'event', turn: 1, e: { k: 'usage' } })).toBeNull();
    expect(parse({ t: 'pong' })).toEqual({ t: 'pong' });
    expect(parse({ t: 'signin', state: 'perhaps' })).toBeNull();
    expect(parse({ t: 'signin', profile: 3, state: 'signed_in' })).toEqual({
      t: 'signin',
      profile: null,
      state: 'signed_in',
    });
    expect(parse({ t: 'signin', profile: 'kimi', state: 'unknown' })).toEqual({
      t: 'signin',
      profile: 'kimi',
      state: 'unknown',
    });
    expect(parse({ t: 'error', code: 'some_new_code' })).toBeNull();
  });
});
