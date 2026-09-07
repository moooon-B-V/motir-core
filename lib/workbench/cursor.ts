import type {
  HomeCursor,
  WatchingCursor,
  WatchingGroup,
} from '@/lib/repositories/workItemRepository';

// The opaque page token for the Workbench's personal reads (Story MOTIR-2649 ·
// MOTIR-2651, widened by MOTIR-4781). Encodes the KEYSET the read orders by, so
// a caller resumes at a POSITION rather than an offset, and the page boundary
// survives items being updated underneath the reader while they page.
//
// Opaque on purpose: base64url of `<iso>|<id>`, and — for Watching —
// `<iso>|<id>|<group>`. The caller round-trips it and never parses it, which is
// exactly what let the token gain that third field without a wire change; the
// original note here promised precisely this and MOTIR-4781 is where it was
// spent.
//
// A malformed or truncated token decodes to `null` — the read then serves page
// one, which is the safe degradation for a token that can only ever arrive from
// a URL a human edited or a stale bookmark.
//
// ⚠️ WHICH TIMESTAMP IS INSIDE IS THE READ'S BUSINESS, NOT THIS MODULE'S. Three
// reads key on `updatedAt` and Recently-finished keys on `completedAt`, and the
// token cannot tell them apart — nor should it, since a cursor minted by one
// read is only ever handed back to that same read. The field is called `at`
// rather than `updatedAt` so nothing here quietly asserts otherwise; the read
// names its own axis (`HomeSortField`).

/** Encode a row's `(at, id)` position into the wire token. */
export function encodeHomeCursor(cursor: HomeCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a wire token back to a keyset, or `null` when it is absent or does not
 * parse. Never throws: an unusable cursor is page one, not a 500.
 */
export function decodeHomeCursor(token: string | null | undefined): HomeCursor | null {
  const parts = splitToken(token);
  return parts ? { at: parts.at, id: parts.id } : null;
}

/**
 * Encode a Watching position — the keyset PLUS the group it was minted in.
 *
 * Watching walks its two groups in sequence (`watcherRepository.listByUser`),
 * so a position alone is ambiguous between them: the same `(updatedAt, id)`
 * pair means "continue among what is moving" in one group and "continue among
 * what is waiting" in the other, and reading it as the first would repeat the
 * whole `in_progress` group on every page after the first.
 */
export function encodeWatchingCursor(cursor: WatchingCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}|${cursor.group}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode a Watching token, or `null` when it is absent or does not parse.
 *
 * A token with no group — an older one, or a plain page cursor pasted in —
 * decodes to the FIRST group. That is the same safe degradation as an
 * unparseable token serving page one: it re-reads from the top of the order
 * rather than skipping rows, and a reader sees a repeat rather than a gap.
 */
export function decodeWatchingCursor(token: string | null | undefined): WatchingCursor | null {
  const parts = splitToken(token);
  if (!parts) return null;
  const group: WatchingGroup = parts.rest === 'todo' ? 'todo' : 'in_progress';
  return { at: parts.at, id: parts.id, group };
}

/** The shared parse. `rest` is whatever followed the id, or `null`. */
function splitToken(
  token: string | null | undefined,
): { at: Date; id: string; rest: string | null } | null {
  if (!token) return null;
  let raw: string;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
    // ⚠️ THE CATCH IS UNREACHABLE, and it stays. `Buffer.from(x, 'base64url')`
    // DISCARDS characters outside the alphabet rather than throwing, so no
    // string entering this function reaches it — the arm is a fact about Node's
    // decoder, not about this module. Kept because this token arrives from a
    // URL on a LANDING page: a decoder that ever starts throwing must degrade to
    // page one, not 500 the first screen after signing in. The invariant is
    // asserted over a corpus of malformed tokens by
    // `tests/workbench/cursor-invariants.test.ts` — "never throws, whatever
    // arrives in the URL", whose last case asserts the decoder's own contract.
    //
    // ⚠️ `start`/`stop`, NOT `next N` — measured on this provider (MOTIR-4784).
    // `next N` counts the DIRECTIVE'S OWN line as the first of the N, so the
    // one-line form suppresses only itself and a multi-line comment swallows its
    // own text (`workItemRepository.ts` records the same measurement from the
    // other direction). The bracketed form has no arithmetic to get wrong.
    /* v8 ignore start */
  } catch {
    return null;
  }
  /* v8 ignore stop */
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const iso = raw.slice(0, separator);
  const tail = raw.slice(separator + 1);
  const second = tail.indexOf('|');
  const id = second === -1 ? tail : tail.slice(0, second);
  const rest = second === -1 ? null : tail.slice(second + 1);
  if (id.length === 0) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return { at, id, rest };
}
