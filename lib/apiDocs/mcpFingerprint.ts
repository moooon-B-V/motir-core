import { createHash } from 'node:crypto';

// The tool-text FINGERPRINT, in its own module (Story MOTIR-2309 · Subtask
// MOTIR-2325 · ADR `public-api-conventions.md` Amendment 12 Q2).
//
// ── Why this is not in `mcp.ts` ─────────────────────────────────────────────
// `lib/apiDocs/mcp.ts` is imported by a PUBLIC page and its whole contract is
// that everything it exports is plain serializable data — no functions and no
// `node:` values on anything a client component could receive. Computing a
// fingerprint needs `node:crypto`; STORING one needs a twelve-character string.
// So the storage lives there and the computation lives here, and the only
// importer of this file is the story's vitest gate (MOTIR-2330), which runs in
// Node and may import anything.
//
// Both sides must agree on the normalization or the pin is worthless, which is
// the reason this is a shared function at all rather than two hashes written
// twice.

/**
 * The fingerprint of one tool's shipped `title` + `description`.
 *
 * Whitespace is collapsed before hashing so that re-wrapping the source literal —
 * which happens every time Prettier reflows a concatenated string — is not a
 * false positive. Anything else is a real change to what the server tells an
 * agent, and should send someone back to re-read the reader-facing summary.
 *
 * Twelve hex characters: enough that a collision is not a practical concern for
 * a set of this size, short enough to sit in a source literal beside the summary
 * it guards without pushing it onto another line.
 */
export function fingerprintToolText(title: string, description: string): string {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${normalize(title)}\n${normalize(description)}`)
    .digest('hex')
    .slice(0, 12);
}
