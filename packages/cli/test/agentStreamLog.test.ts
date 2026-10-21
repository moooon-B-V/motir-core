import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentStreamFormatter, lookupSessionId } from '../src/agentStreamLog.js';
import type { ChatAdapter } from '../src/agentTerminal/chat/adapter.js';

// The stream → readable lines step of a run in the developer's own agent (MOTIR-8980).
// Every case replays a RECORDED stream from the chat tab's fixtures (the same ones the
// adapters' own tests pin), so the run and the chat cannot read a profile differently.

function fixture(profile: string, name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./agentTerminal/fixtures/chat/${profile}/${name}`, import.meta.url)),
    'utf8',
  );
}

/** The log a whole recorded stream produces, with the fixture's own `#` header line removed. */
function replay(
  profile: string,
  name: string,
  slice = Infinity,
): { text: string; id: string | null } {
  const formatter = createAgentStreamFormatter(profile)!;
  const body = fixture(profile, name)
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  let text = '';
  for (let i = 0; i < body.length; i += slice) text += formatter.write(body.slice(i, i + slice));
  text += formatter.flush();
  return { text, id: formatter.sessionId() };
}

/** No line of a log is an event object: the whole point of the step. */
function expectNoRawJson(text: string): void {
  for (const line of text.split('\n')) expect(line.trimStart().startsWith('{'), line).toBe(false);
}

describe('each profile’s recorded stream becomes readable lines', () => {
  it('claude: a Bash call is one line, then the reply', () => {
    const { text, id } = replay('claude', 'bash.jsonl');
    expect(text).toBe('Bash: ls\nThe directory contains the files listed above.\n');
    expect(id).toBe('49c4fa44-2f7e-4f0a-9d3b-5a1c0e7b2d10');
  });

  it('claude: a read, an edit, and a failed command naming its exit code', () => {
    expect(replay('claude', 'read.jsonl').text).toContain('Read /home/agent/workspace/README.md\n');
    expect(replay('claude', 'edit.jsonl').text).toContain(
      'Edit /home/agent/workspace/src/greet.ts\n',
    );
    expect(replay('claude', 'failed-tool.jsonl').text).toBe(
      'Bash: cat missing.txt\n  ✗ failed (exit 1)\nmissing.txt does not exist.\n',
    );
  });

  it('codex: the thread id is the session, a command is one line', () => {
    const { text, id } = replay('codex', 'command.jsonl');
    expect(text).toBe('Bash: /bin/bash -lc ls\nThe directory contains the files listed above.\n');
    expect(id).toBe('01a0f1e6-e507-7c00-a172-76c9ce46e8f1');
  });

  it('codex: a failed turn is an error line, not a JSON event', () => {
    expect(replay('codex', 'turn-failed.jsonl').text).toContain(
      'error: turn_failed — stream disconnected before completion\n',
    );
  });

  it('opencode: read, edit and command each get a line; the sessionID is the session', () => {
    const { text, id } = replay('opencode', 'read-edit-command.jsonl');
    expect(text).toBe(
      'Read /home/agent/workspace/hello.txt\n' +
        'Edit /home/agent/workspace/hello.txt\n' +
        'Bash: ls\n' +
        'I fixed the typo in hello.txt. The directory contains a.txt, b.md, hello.txt and opencode.json.\n',
    );
    expect(id).toBe('ses_f0e15f2f2ffeRhqhbBfRDMXLUT');
  });

  it('kimi: tool calls are lines and the resume hint is the session', () => {
    const { text, id } = replay('kimi', 'tools.jsonl');
    expect(text).toBe(
      "I'll read the README first.\nRead README.md\nEdit README.md\nBash: ls\n" +
        'I fixed the typo in README.md. The directory contains the files listed above.\n',
    );
    expect(id).toBe('session_542c66ca-c9c4-4267-ba4b-10bfab95ff91');
  });

  it('goose: a shell call and an edit are lines (its stream names no session)', () => {
    const { text, id } = replay('goose', 'shell-and-edit.jsonl');
    expect(text).toBe('Bash: ls\nEdit /home/node/workspace/a.txt\nThe directory listed above.\n');
    expect(id).toBeNull();
  });

  it('never writes an event object, whatever the profile or fixture', () => {
    for (const [profile, files] of Object.entries({
      claude: ['bash', 'edit', 'failed-tool', 'read', 'stopped', 'text-reply', 'unknown-line'],
      codex: ['command', 'file-change', 'interrupted', 'other-events', 'turn-failed'],
      opencode: ['plain-reply', 'read-edit-command', 'stopped', 'failed-tool'],
      kimi: ['plain-reply', 'tools', 'stopped', 'failed-tool'],
      goose: ['plain-reply', 'shell-and-edit', 'stopped', 'failed-tool'],
    })) {
      for (const file of files) expectNoRawJson(replay(profile, `${file}.jsonl`).text);
    }
  });
});

describe('chunking', () => {
  it('a stream cut at any byte produces the same log as the whole', () => {
    for (const [profile, name] of [
      ['claude', 'bash.jsonl'],
      ['codex', 'file-change.jsonl'],
      ['opencode', 'read-edit-command.jsonl'],
      ['kimi', 'tools.jsonl'],
    ] as const) {
      const whole = replay(profile, name).text;
      expect(replay(profile, name, 7).text).toBe(whole);
      expect(replay(profile, name, 1).text).toBe(whole);
    }
  });

  it('holds a half line until its newline, so a cut object never leaks', () => {
    const formatter = createAgentStreamFormatter('claude')!;
    expect(formatter.write('{"type":"assistant","message":{"id":"m1","content":[{"type":"te')).toBe(
      '',
    );
    expect(formatter.write('xt","text":"hi"}]}}\n')).toBe('hi');
    expect(formatter.flush()).toBe('\n');
  });

  it('writes a delta stream onto one line and closes it when something else arrives', () => {
    const formatter = createAgentStreamFormatter('claude')!;
    const delta = (text: string) =>
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      }) + '\n';
    const start =
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm1' } },
      }) + '\n';
    let out = formatter.write(start);
    out += formatter.write(delta('Hello, '));
    out += formatter.write(delta('world'));
    expect(out).toBe('Hello, world');
    const tool =
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      }) + '\n';
    expect(formatter.write(tool)).toBe('\nBash: pnpm test\n');
  });
});

describe('what is not an event', () => {
  it('passes a plain-text line through, and drops a line that is an event with nothing to draw', () => {
    const formatter = createAgentStreamFormatter('claude')!;
    expect(formatter.write('warning: something plain\n')).toBe('warning: something plain\n');
    expect(formatter.write('{"type":"rate_limit_event"}\n')).toBe('');
    expect(formatter.write('{not json at all\n')).toBe('');
  });

  it('has no formatter for a profile no chat adapter reads', () => {
    expect(createAgentStreamFormatter('aider')).toBeNull();
    expect(createAgentStreamFormatter('not-an-agent')).toBeNull();
  });

  it('cuts a very long command to one readable line', () => {
    const formatter = createAgentStreamFormatter('claude')!;
    const line =
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: `echo ${'x'.repeat(500)}\nls` },
            },
          ],
        },
      }) + '\n';
    const out = formatter.write(line);
    expect(out.endsWith('…\n')).toBe(true);
    expect(out.length).toBeLessThan(260);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('lookupSessionId', () => {
  const adapter = (updatedAt: string | null, fail = false): ChatAdapter =>
    ({
      profile: 'goose',
      listSessions: async () => {
        if (fail) throw new Error('store unreadable');
        return updatedAt === null ? [] : [{ id: 'goose-7', title: 't', updatedAt }];
      },
    }) as unknown as ChatAdapter;
  const ctx = { cwd: '/work/PROD-1', env: { HOME: '/home/dev' } };
  const since = Date.parse('2026-10-19T09:00:00Z');

  it('names the newest session touched since the run began', async () => {
    expect(await lookupSessionId('goose', ctx, since, adapter('2026-10-19T09:05:00Z'))).toBe(
      'goose-7',
    );
  });

  it('never names a session from before the run — an old conversation is not this one', async () => {
    expect(await lookupSessionId('goose', ctx, since, adapter('2026-10-18T09:05:00Z'))).toBeNull();
  });

  it('is null when there is no session, no adapter or an unreadable store', async () => {
    expect(await lookupSessionId('goose', ctx, since, adapter(null))).toBeNull();
    expect(
      await lookupSessionId('goose', ctx, since, adapter('2026-10-19T09:05:00Z', true)),
    ).toBeNull();
    expect(await lookupSessionId('aider', ctx, since)).toBeNull();
  });
});
