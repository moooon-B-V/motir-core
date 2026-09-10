import { buildProgram } from './program.js';
import { CliError } from './errors.js';
import { isInteractive, promptLine } from './prompts.js';
import { announceStaleness, isUnattendedArgv, shouldCheckStaleness } from './staleness.js';

// The `motir` binary entrypoint (tsup adds the `#!/usr/bin/env node` shebang).
// A thrown `CliError` is a clean user-facing failure: print its message (+ hint)
// to stderr and exit with its code. Anything else is an unexpected bug — print
// the stack so it's debuggable, exit 1.
async function main(): Promise<void> {
  // ── IS THIS CLI OUT OF DATE? (MOTIR-4973 · MOTIR-4970) ────────────────────
  // Here rather than in a commander `preAction` hook, for two reasons. It runs
  // ONCE per process instead of once per action, which is what a version check
  // should be; and an ASYNC hook forces every call site onto `parseAsync` —
  // `buildProgram()` is parsed synchronously by the help suite, and a deferred
  // action there renders empty help. The entrypoint is already async, so this is
  // the seam that costs nothing.
  //
  // A failure here may never reach the user: this precedes the command they
  // typed, and a courtesy notice that broke `motir run` would be a far worse
  // defect than the staleness it reports.
  const argv = process.argv.slice(2);
  if (shouldCheckStaleness(argv)) {
    const prompt =
      isUnattendedArgv(argv) || !isInteractive() ? {} : { confirm: (q: string) => promptLine(q) };
    await announceStaleness(prompt).catch(() => {});
  }

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
    process.exit(err.exitCode);
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`Unexpected error: ${detail}\n`);
  process.exit(1);
});
