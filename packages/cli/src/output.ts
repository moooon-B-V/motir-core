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

/**
 * A VERBATIM payload → stdout, terminated by exactly one newline.
 *
 * Used for the server-generated dispatch prompt, whose contract is that the CLI
 * prints it byte-identical (no client-side prompt assembly). `out()` would
 * append a second newline to text that already ends in one, so the prompt gets
 * its own writer rather than a reformatting one.
 */
export function outVerbatim(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

/** A pretty JSON payload → stdout (for `--json` flags). */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * A VERBATIM payload → stderr, terminated by exactly one newline.
 *
 * The stderr sibling of {@link outVerbatim}, and it exists for exactly one
 * caller: `--print-prompt`, which echoes the server-assembled prompt WHILE the
 * run it belongs to is happening (MOTIR-3052). That makes it narration about
 * work also in flight — this module's stderr half — rather than the payload
 * `--print` puts on stdout, so the two flags compose on one command line instead
 * of interleaving two copies of a 200-line prompt on one stream.
 *
 * ⚠️ NOT `info()`. `info` appends a newline unconditionally, which would make
 * the echoed transcript differ from the string handed to the agent by one byte
 * whenever the prompt already ends in one — and a transcript that is not
 * byte-identical to what was sent is worse than no transcript, because it can
 * disagree with the run it claims to describe. Same reasoning, and the same
 * terminator rule, as `outVerbatim`.
 */
export function errVerbatim(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : text + '\n');
}
