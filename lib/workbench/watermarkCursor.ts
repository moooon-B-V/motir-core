import {
  WORKBENCH_TAB_KEYS,
  type WorkbenchTabKey,
  type WorkbenchTabWatermarkDto,
} from '@/lib/dto/workbench';

// THE WORKBENCH WATERMARK CURSOR (Story MOTIR-5238 · Subtask MOTIR-5240) — the
// codec for the opaque string a live client presents as `?since=`.
//
// ⚠️ THE CURSOR IS THE WHOLE STATE, which is what makes the stream stateless. A
// run's stream resumes from `seq` on an append-only table and the
// `@@unique([dispatchRunId, seq])` is its guarantee; the Workbench has no such
// table and this story adds none, so the client carries its own position and the
// server compares rather than remembers. A route that remembered what it had
// sent would be wrong after a redeploy, and would be wrong per-connection rather
// than visibly.
//
// ⚠️ AND A MISSED FRAME IS HARMLESS BY CONSTRUCTION. The cursor names a state,
// not a position in a sequence, so replaying one is idempotent: the client
// re-reads whatever the comparison names and a dropped connection costs a stale
// second, never a wrong list.

/**
 * The format marker. A cursor minted by an older or newer build decodes to
 * `null`, which the service reads as *I cannot compare this* and answers by
 * naming every tab — see {@link decodeWatermarkCursor}.
 */
const CURSOR_VERSION = 'w1';

/** One tab's pair as it travels: `[count, epochMillis]`, with `0` for an empty tab. */
type PackedTab = [number, number];

/**
 * Pack every tab's pair into a URL-safe string.
 *
 * Base64URL of a compact JSON array rather than a readable `a=1;b=2` — the
 * cursor rides in a query string and is echoed in logs, and an opaque token is
 * what stops a client parsing it and depending on the shape. The VERSION stays
 * outside the encoding so a cursor's vintage is legible without decoding it.
 */
export function encodeWatermarkCursor(
  tabs: Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>,
): string {
  const packed: PackedTab[] = WORKBENCH_TAB_KEYS.map((key) => [
    tabs[key].count,
    tabs[key].latest === null ? 0 : Date.parse(tabs[key].latest),
  ]);
  return `${CURSOR_VERSION}.${Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url')}`;
}

/**
 * Read a cursor back, or answer `null` when it cannot be read.
 *
 * ⚠️ `null` IS NOT AN ERROR AND IT IS NOT *NOTHING MOVED* — it is *I cannot
 * compare*, and the caller's answer to that is to name every tab. Every way a
 * cursor can be unreadable (a client on an older build, a truncated query
 * string, a hand-edited URL) is a way for a reader to be holding a list this
 * stream can no longer speak about, and a re-read costs one render.
 *
 * An ABSENT cursor is a different question and never reaches here: a reader who
 * has presented nothing has had nothing move under them.
 */
export function decodeWatermarkCursor(
  cursor: string | null | undefined,
): Record<WorkbenchTabKey, WorkbenchTabWatermarkDto> | null {
  if (!cursor) return null;
  const [version, payload] = cursor.split('.');
  if (version !== CURSOR_VERSION || !payload) return null;
  let packed: unknown;
  try {
    packed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(packed) || packed.length !== WORKBENCH_TAB_KEYS.length) return null;

  const tabs = {} as Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>;
  for (const [index, key] of WORKBENCH_TAB_KEYS.entries()) {
    const pair: unknown = packed[index];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [count, millis] = pair as [unknown, unknown];
    if (typeof count !== 'number' || typeof millis !== 'number') return null;
    if (!Number.isFinite(count) || !Number.isFinite(millis)) return null;
    tabs[key] = {
      count,
      latest: millis === 0 ? null : new Date(millis).toISOString(),
    };
  }
  return tabs;
}

/**
 * WHICH TABS DIFFER between a decoded cursor and the current reading, in strip
 * order.
 *
 * A `null` cursor — absent — moves nothing; that case is the caller's, because
 * *absent* and *unreadable* are opposite answers and only one of them is safe to
 * treat as quiet.
 */
export function movedTabs(
  since: Record<WorkbenchTabKey, WorkbenchTabWatermarkDto> | null,
  now: Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>,
): WorkbenchTabKey[] {
  if (since === null) return [];
  return WORKBENCH_TAB_KEYS.filter(
    (key) => since[key].count !== now[key].count || since[key].latest !== now[key].latest,
  );
}
