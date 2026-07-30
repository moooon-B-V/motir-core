// User-code presentation + canonicalisation for the `/device` approval page
// (Story MOTIR-1863 · Subtask MOTIR-1867).
//
// Deliberately a pure, dependency-free module so the CLIENT island can import it:
// `lib/cliDevice/constants.ts` is dependency-free too, but it is the server's
// decision-record (it is what `lib/auth/index.ts` configures the plugin from), and
// the page needs none of those values. Keeping the two apart means the browser
// bundle carries eight lines of string handling rather than the grant's parameters.
//
// THE SERVER RE-NORMALISES REGARDLESS. `cliDeviceService.normalizeUserCode` strips
// dashes and upper-cases before it touches a row, and Better-Auth strips dashes
// again inside the plugin. Nothing here is a security boundary — it exists so the
// human sees the form the server matched, and so a code typed with the grouping
// dash, in lower case, or with a stray space pasted from a terminal still resolves
// the same row.

/** The plugin's `userCodeLength` default, which this deployment does not override. */
export const USER_CODE_LENGTH = 8;

/** Where the display dash falls: `XXXX-XXXX`. */
const GROUP_SIZE = 4;

/**
 * The canonical form the server matches on: no dashes, no whitespace, upper case.
 *
 * More forgiving than the server's own strip (dashes only) on purpose — this is
 * what a human typed or pasted, and a trailing space from a terminal copy is not a
 * wrong code. The generator's charset is `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, so
 * folding case can only ever rescue someone who typed lower case; it can never
 * collide two distinct codes.
 */
export function normalizeUserCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * The display form, `XXXX-XXXX`. Applied to whatever has been typed so far, so the
 * field groups as the human goes rather than reformatting under them at the end.
 * A longer-than-expected paste is left ungrouped past the first dash rather than
 * silently truncated — the server will reject it, and a code the user can still
 * see is one they can still fix.
 */
export function formatUserCode(raw: string): string {
  const canonical = normalizeUserCode(raw);
  if (canonical.length <= GROUP_SIZE) return canonical;
  return `${canonical.slice(0, GROUP_SIZE)}-${canonical.slice(GROUP_SIZE)}`;
}

/** A code that is worth sending — the length the generator emits, nothing else. */
export function isCompleteUserCode(raw: string): boolean {
  return normalizeUserCode(raw).length === USER_CODE_LENGTH;
}

/**
 * Is a post-sign-in destination a `/device` hand-off, and which code is waiting?
 * Returns the canonical code (`''` for a bare `/device` return), or `null` when the
 * destination has nothing to do with the CLI.
 *
 * PARSED, never pattern-matched. The sign-in page lights a "your code came with
 * you" banner off this, and `next=` is attacker-controlled — a substring test would
 * let `https://evil.example/device?user_code=…` dress a phishing hop up in Motir's
 * own CLI-connect chrome. Only a same-origin relative path counts.
 */
export function readDeviceUserCode(callbackURL: string): string | null {
  // A protocol-relative `//host/device` is absolute despite the leading slash, so
  // the cheap prefix test is not enough on its own — the parse below resolves
  // against a placeholder origin, and anything that escapes it fails the host check.
  if (!callbackURL.startsWith('/')) return null;
  const base = 'https://device-handoff.invalid';
  let url: URL;
  try {
    url = new URL(callbackURL, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  if (url.pathname !== '/device') return null;
  return normalizeUserCode(url.searchParams.get('user_code') ?? '');
}
