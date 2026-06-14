// The triage-queue filter limit + opaque cursor codec (Story 6.11 · Subtask
// 6.11.3). The inbox queue read (`workItemRepository.findTriageQueue`) and the
// `triageService.getTriageQueue` service share this one cursor format so the
// admin inbox UI (6.11.6) pages through the queue deterministically.
//
// The order the cursor encodes is the queue's `(triagedAt DESC, id ASC)`:
// newest submission first, the work-item `id` breaking the (rare) same-instant
// tie. Encoding the (triagedAt, id) TUPLE (not a row offset) keeps paging
// stable across concurrent intake — an offset breaks the moment a newer
// submission lands at the top, but the seek-after position is reproducible.

/**
 * The (triagedAt, id) seek-after position a queue cursor decodes to — the last
 * item of the previous page. `triagedAt` is the marker timestamp as an ISO-8601
 * string (wire-safe); `id` is the work-item id.
 */
export interface TriageQueueCursorToken {
  triagedAt: string;
  id: string;
}

export const TRIAGE_QUEUE_DEFAULT_LIMIT = 50;
export const TRIAGE_QUEUE_MAX_LIMIT = 100;

/**
 * A caller passed a `cursor` that isn't a well-formed `base64url([triagedAt,
 * id])` token (bad base64, bad JSON, a non-ISO date, or a non-string id). The
 * route layer maps this to a 400 — distinct from a VALID cursor that points past
 * the tail, which returns an empty page, not an error.
 */
export class InvalidTriageCursorError extends Error {
  readonly code = 'INVALID_TRIAGE_CURSOR' as const;
  constructor() {
    super('Invalid triage queue cursor.');
    this.name = 'InvalidTriageCursorError';
  }
}

/** Encode a (triagedAt, id) position into the opaque page cursor. */
export function encodeTriageCursor(cursor: TriageQueueCursorToken): string {
  return Buffer.from(JSON.stringify([cursor.triagedAt, cursor.id]), 'utf8').toString('base64url');
}

/**
 * Decode the opaque page cursor back to its (triagedAt, id) position. Throws
 * {@link InvalidTriageCursorError} on any malformed token so the route returns
 * 400 rather than silently treating garbage as "start from the top". A valid
 * `triagedAt` must parse as a real date (rejects `"not-a-date"`).
 */
export function decodeTriageCursor(raw: string): TriageQueueCursorToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTriageCursorError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    Number.isNaN(Date.parse(parsed[0])) ||
    typeof parsed[1] !== 'string' ||
    parsed[1].length === 0
  ) {
    throw new InvalidTriageCursorError();
  }
  return { triagedAt: parsed[0], id: parsed[1] };
}

/**
 * Clamp a caller-supplied limit into `[1, TRIAGE_QUEUE_MAX_LIMIT]`. A missing or
 * non-positive / non-finite value falls back to `TRIAGE_QUEUE_DEFAULT_LIMIT`; an
 * over-cap value is clamped DOWN (the inbox clamps silently rather than 400).
 */
export function clampTriageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1)
    return TRIAGE_QUEUE_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), TRIAGE_QUEUE_MAX_LIMIT);
}
