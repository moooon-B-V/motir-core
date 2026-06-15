import { buildProgram } from './program.js';
import { CliError } from './errors.js';

// The `motir` binary entrypoint (tsup adds the `#!/usr/bin/env node` shebang).
// A thrown `CliError` is a clean user-facing failure: print its message (+ hint)
// to stderr and exit with its code. Anything else is an unexpected bug — print
// the stack so it's debuggable, exit 1.
async function main(): Promise<void> {
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
