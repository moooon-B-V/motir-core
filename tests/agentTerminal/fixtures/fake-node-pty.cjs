'use strict';

// A STAND-IN FOR `node-pty` (Story MOTIR-6861 · MOTIR-6942, the story gate).
//
// The real terminal server (`motir agent-terminal serve`) loads node-pty from
// `$MOTIR_TERMINAL_MODULE_DIR/node_modules/node-pty` (`packages/cli/src/agentTerminal/pty.ts`).
// node-pty compiles native code and is not built in CI (it is compiled into the
// agent image only, `docs/decisions/agent-terminal.md` Q4), so the gate installs
// THIS module there when no real node-pty is available. The gate then still runs
// the REAL server process, over the REAL relay, with a REAL `bash` behind it:
//
//   * the shell is `bash --noprofile --norc` over pipes — commands really run,
//     one process per session, so `$$` and exported variables survive a
//     detach exactly as they would on a PTY;
//   * a PTY's CR → NL input translation (`icrnl`) is reproduced, because the
//     browser sends `\r` for Enter;
//   * what a pipe cannot have is a WINDOW SIZE, so `stty` is shimmed on the
//     shell's PATH to print the size this adapter was last `resize`d to, in
//     `stty size`'s own `rows cols` shape.
//
// It exports exactly the `spawn` subset `pty.ts`'s adapter calls. Where a real
// node-pty IS available (MOTIR_TERMINAL_MODULE_DIR pointing at a built one), the
// gate uses that instead and this file is not loaded.

// CommonJS on purpose: `pty.ts` loads node-pty with `createRequire(...)('node-pty')`,
// exactly as it loads the real (CommonJS) package in the image.
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn: spawnChild } = require('node:child_process');
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { constants, tmpdir } = require('node:os');
const { join } = require('node:path');

exports.spawn = function spawn(_file, _args, options) {
  const dir = mkdtempSync(join(tmpdir(), 'motir-fake-pty-'));
  const sizeFile = join(dir, 'size');
  const writeSize = (cols, rows) => writeFileSync(sizeFile, `${rows} ${cols}\n`);
  writeSize(options.cols, options.rows);
  const stty = join(dir, 'stty');
  writeFileSync(stty, '#!/bin/sh\ncat "$MOTIR_FAKE_PTY_SIZE"\n');
  chmodSync(stty, 0o755);

  const env = {
    ...options.env,
    PATH: `${dir}:${options.env.PATH || '/usr/bin:/bin'}`,
    MOTIR_FAKE_PTY_SIZE: sizeFile,
  };
  const child = spawnChild('bash', ['--noprofile', '--norc'], {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const dataListeners = [];
  const exitListeners = [];
  const emit = (chunk) => {
    for (const listener of dataListeners) listener(Buffer.from(chunk));
  };
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  child.stdin.on('error', () => {});
  child.on('close', (code, signal) => {
    rmSync(dir, { recursive: true, force: true });
    const exit = { exitCode: code ?? 0, signal: signal ? constants.signals[signal] : undefined };
    for (const listener of exitListeners) listener(exit);
  });

  return {
    pid: child.pid,
    onData(listener) {
      dataListeners.push(listener);
      return { dispose() {} };
    },
    onExit(listener) {
      exitListeners.push(listener);
      return { dispose() {} };
    },
    write(data) {
      const text = Buffer.from(data).toString('utf8').replace(/\r\n?/g, '\n');
      child.stdin.write(text);
    },
    resize(cols, rows) {
      writeSize(cols, rows);
    },
    kill() {
      child.kill('SIGHUP');
    },
  };
};
