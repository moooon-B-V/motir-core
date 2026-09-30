import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The PTY seam (MOTIR-6938 · `docs/decisions/agent-terminal.md` Q4).
//
// `node-pty` is NOT a dependency of `@motir/cli`: it compiles native code on
// Linux, and the package is installed on laptops. The sandbox image builds a
// pinned version into `/opt/motir-terminal` in its own stage, and `serve` loads
// it from there at run time. Everything else in the server talks to the small
// interface below, so the tests drive a fake PTY and never need a compiler.

/** Where the image puts node-pty. Overridable so a test can point elsewhere. */
export const DEFAULT_TERMINAL_MODULE_DIR = '/opt/motir-terminal';
export const TERMINAL_MODULE_DIR_ENV = 'MOTIR_TERMINAL_MODULE_DIR';

/** The refusal `serve` gives outside an agent image, word for word (Q4). */
export const NOT_AN_AGENT_IMAGE = 'The terminal server runs inside a Motir agent image.';

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: Buffer) => void): void;
  onExit(listener: (exit: { exitCode: number | null; signal: number | null }) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (options: PtySpawnOptions) => PtyProcess;

/** The subset of node-pty's module this adapter uses. */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      encoding: null;
    },
  ): {
    pid: number;
    onData(listener: (data: Buffer | string) => void): unknown;
    onExit(listener: (exit: { exitCode: number; signal?: number }) => void): unknown;
    write(data: Buffer | string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
}

/**
 * Load node-pty from the image's directory, or return null when it is not
 * there (a laptop, CI). Never throws for an absent module; a present-but-broken
 * one (an ABI mismatch) also answers null, since either way this is not an
 * image that can serve.
 */
export function loadNodePty(dir: string): SpawnPty | null {
  if (!existsSync(join(dir, 'node_modules', 'node-pty'))) return null;
  let mod: NodePtyModule;
  try {
    mod = createRequire(join(dir, 'package.json'))('node-pty') as NodePtyModule;
  } catch {
    return null;
  }
  return (options) => {
    const child = mod.spawn(options.file, options.args, {
      name: options.env['TERM'] ?? 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
      // Raw bytes, not decoded strings: a multi-byte character split across two
      // reads must reach the browser intact, and the replay ring holds bytes.
      encoding: null,
    });
    return {
      pid: child.pid,
      onData: (listener) => {
        child.onData((data) => listener(typeof data === 'string' ? Buffer.from(data) : data));
      },
      onExit: (listener) => {
        child.onExit((exit) => listener({ exitCode: exit.exitCode, signal: exit.signal ?? null }));
      },
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill(),
    };
  };
}
