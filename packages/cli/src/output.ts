// Output helpers. We write to the streams directly (not `console.*`) so:
//   - stdout carries the PRIMARY payload (a prompt, JSON, a table) and stays
//     clean for piping;
//   - stderr carries human status / diagnostics, so `motir next --print | …`
//     pipes only the prompt.
// This split is load-bearing for the dispatch commands (7.9.3) and is the
// reason the package avoids `console.log` entirely.

/** Primary payload → stdout. */
export function out(line = ''): void {
  process.stdout.write(line + '\n');
}

/** Status / diagnostics → stderr. */
export function info(line = ''): void {
  process.stderr.write(line + '\n');
}

/** A pretty JSON payload → stdout (for `--json` flags). */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
