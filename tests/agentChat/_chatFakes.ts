import { EventEmitter } from 'node:events';
import type {
  ChatAdapter,
  ChatSupport,
  TranscriptMapper,
  TurnCommand,
} from '../../packages/cli/src/agentTerminal/chat/adapter';
import type {
  ChatErrorCode,
  ChatSessionSummary,
  TranscriptEvent,
} from '../../packages/cli/src/agentTerminal/chat/protocol';
import type {
  ChatProcess,
  ChatProcessExit,
  ChatSignal,
  ChatSpawnOptions,
  SpawnChat,
} from '../../packages/cli/src/agentTerminal/chat/turns';
import type {
  PtyProcess,
  PtySpawnOptions,
  SpawnPty,
} from '../../packages/cli/src/agentTerminal/pty';

// The chat story gate's stand-ins for the two PROCESSES the in-agent server
// starts — the shell's PTY and a chat turn's CLI — and one adapter whose dialect
// a test writes by hand (Story MOTIR-6863 · MOTIR-7018).
//
// They mirror `packages/cli/test/agentTerminal/harness.ts` (MOTIR-6938/7012),
// which the root test project cannot import: it lives outside every TypeScript
// project the root build references. Everything else the gates drive — the
// server, the runner, the five adapters — is the CLI package's real source.

/** A shell that echoes nothing and exits when killed. */
class FakePty implements PtyProcess {
  private readonly events = new EventEmitter();
  private killed = false;
  constructor(readonly pid: number) {}
  onData(listener: (data: Buffer) => void): void {
    this.events.on('data', listener);
  }
  onExit(listener: (exit: { exitCode: number | null; signal: number | null }) => void): void {
    this.events.on('exit', listener);
  }
  write(): void {}
  resize(): void {}
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.events.emit('exit', { exitCode: null, signal: 1 });
  }
}

export function fakePtySpawner(): { spawn: SpawnPty; spawned: PtySpawnOptions[] } {
  const spawned: PtySpawnOptions[] = [];
  const spawn: SpawnPty = (options) => {
    spawned.push(options);
    return new FakePty(1000 + spawned.length);
  };
  return { spawn, spawned };
}

/** A chat turn's CLI: the test prints its lines and decides its exit. */
export class FakeChatProcess implements ChatProcess {
  readonly signals: ChatSignal[] = [];
  exited = false;
  private readonly events = new EventEmitter();

  constructor(
    readonly options: ChatSpawnOptions,
    readonly pid: number,
  ) {}

  onStdout(listener: (chunk: Buffer) => void): void {
    this.events.on('stdout', listener);
  }
  onExit(listener: (exit: ChatProcessExit) => void): void {
    this.events.on('exit', listener);
  }
  /** SIGKILL ends a process, as it must; SIGINT is the test's to answer. */
  signal(signal: ChatSignal): void {
    this.signals.push(signal);
    if (signal === 'SIGKILL') this.exit(null, 'SIGKILL');
  }
  /** One stdout line. */
  line(value: Record<string, unknown> | string): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.events.emit('stdout', Buffer.from(`${text}\n`));
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', { code, signal });
  }
}

export function fakeChatSpawner(): { spawn: SpawnChat; procs: FakeChatProcess[] } {
  const procs: FakeChatProcess[] = [];
  const spawn: SpawnChat = (options) => {
    const proc = new FakeChatProcess(options, 2000 + procs.length);
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

/**
 * An adapter with a hand-written dialect, one JSON object per line:
 *   {"type":"text","id","text"}   assistant text
 *   {"type":"end"}                the end-of-turn marker
 *   {"type":<anything else>}      an unmapped event → `other`
 */
export class FakeChatAdapter implements ChatAdapter {
  answer: ChatSupport = { supported: true };

  constructor(readonly profile: string) {}

  async support(): Promise<ChatSupport> {
    return this.answer;
  }

  turnCommand(input: { prompt: string; sessionId: string | null }): TurnCommand {
    return {
      file: 'fake-agent',
      args: input.sessionId ? ['--resume', input.sessionId] : [],
      stdin: input.prompt,
    };
  }

  createMapper(): TranscriptMapper {
    let ended = false;
    const kill: ChatErrorCode | null = null;
    return {
      onLine: (line): TranscriptEvent[] => {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return [];
        }
        if (value['type'] === 'text') {
          return [{ k: 'text', id: String(value['id']), delta: String(value['text']) }];
        }
        if (value['type'] === 'end') {
          ended = true;
          return [];
        }
        return [{ k: 'other', name: String(value['type']) }];
      },
      sessionId: () => null,
      sawEnd: () => ended,
      killCode: () => kill,
    };
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    return [];
  }

  async readHistory(): Promise<{ events: TranscriptEvent[]; truncated: boolean }> {
    return { events: [], truncated: false };
  }
}
