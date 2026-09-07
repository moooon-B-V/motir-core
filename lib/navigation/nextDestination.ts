/**
 * Where a `?next=` hand-off is allowed to send someone (MOTIR-3372).
 *
 * The credential surfaces carry an explicit destination for the flows that
 * cannot re-derive theirs — `/device` packs the CLI's user code into
 * `?next=/device?user_code=…` (it builds that bounce itself, client-side), and
 * every deep link that bounced through auth carries the page it wanted. So a
 * QUERY STRING has always been part of a legal value here, and since MOTIR-4725
 * `proxy.ts`'s own bounce carries one too — the planning workspace is an overlay
 * whose open state lives entirely in the query, so a destination without it is a
 * different page.
 * Until MOTIR-3372 that value was only ever read CLIENT-side, as the
 * `callbackURL` Better-Auth navigates to after a successful sign-in. Now the
 * server shells follow it too, for a reader who is ALREADY signed in and needs
 * no credentials at all — which makes it a value the SERVER acts on, and that
 * raises a question the client path never had to answer.
 *
 * **An unvalidated `next` is an open redirect.** `redirect('https://evil.example')`
 * in a Server Component answers with a 307 to another origin, and the link that
 * did it is a link to `app.motir.co` — the exact shape a phishing page wants. So
 * the value is narrowed to what the feature actually needs: a path on THIS
 * origin.
 *
 * A path qualifies when it starts with a single `/` and cannot be read as
 * anything else:
 *
 *   - `//evil.example` and `/\evil.example` are PROTOCOL-RELATIVE. Browsers
 *     resolve both to another origin (Chrome and Firefox normalise the
 *     backslash), so a leading-slash check alone is not enough.
 *   - `https://…`, `javascript:…`, `mailto:…` — anything carrying a scheme —
 *     never starts with `/`, so the first rule already excludes them. The
 *     control-character check covers the header-splitting variants, which are
 *     REJECTED rather than stripped: a destination nobody typed is not one to
 *     repair.
 *
 * Everything else about the destination is somebody else's business: whether the
 * route exists (Next answers with its own 404), and whether the reader may see
 * it (the destination's own gate answers that — this grants no access).
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The `?next=` value as a safe same-origin path, or `null` when there is none to
 * follow. `null` means "use the caller's default" — never "redirect anyway".
 *
 * @param raw the search param, which Next hands over as a string, an array (a
 *   hand-edited URL can repeat the key) or `undefined`.
 */
export function sanitizeNextPath(raw: string | string[] | undefined): string | null {
  // A repeated key takes the first value, the same way `/device` reads
  // `user_code` — one of them is the intended one, and a nonsense value is
  // rejected by the rules below rather than guessed at.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  if (!value.startsWith('/')) return null;
  // Protocol-relative, in both of its spellings.
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}
