import {
  MONITOR_EVIDENCE_MESSAGE_MAX,
  MONITOR_EVIDENCE_PATH_MAX,
  MONITOR_EVIDENCE_TAG_VALUE_MAX,
  MONITOR_EVIDENCE_TAGS_MAX,
  type NormalizedMonitorTag,
} from './types';

// The EVIDENCE filters every monitor adapter applies before a latest event's
// context leaves the seam (Story MOTIR-5975 · Subtask MOTIR-5977).
//
// ⚠️ PROVIDER-NEUTRAL AND PURE, AND THAT IS WHY IT IS NOT IN `sentry.ts`. The
// fake and every future adapter must drop exactly the same set, so the set lives
// once, here, and both registered adapters call it. A filter written inside one
// adapter is a filter the next adapter forgets.
//
// ⚠️ A DENYLIST, NOT AN ALLOWLIST. The custom tags a team sets — a route name, a
// webhook's event type — are precisely the useful ones, and an allowlist would
// drop every one of them by default. The monitor already scrubs server-side;
// this is the second line, on our side of the wire.

/** Tag keys that identify a PERSON, dropped wherever a tag is read. A key equal
 *  to `user` or starting with `user.` is dropped too (Sentry's `user.email`,
 *  `user.id`, `user.username`, …) — see {@link isUserIdentifyingTagKey}. */
export const MONITOR_USER_IDENTIFYING_TAG_KEYS: readonly string[] = [
  'user',
  'ip',
  'ip_address',
  'client_ip',
  'email',
  'username',
];

/** Whether a tag key names a person — the ONE predicate the filter and the
 *  guards downstream of it read. */
export function isUserIdentifyingTagKey(key: string): boolean {
  return MONITOR_USER_IDENTIFYING_TAG_KEYS.includes(key) || key.startsWith('user.');
}

/** A string cut to `max` characters, ending in `…` when it was cut — so a reader
 *  can always tell a whole value from a truncated one. */
export function boundEvidenceText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** An exception message bounded by {@link MONITOR_EVIDENCE_MESSAGE_MAX}. */
export function boundExceptionMessage(message: string): string {
  return boundEvidenceText(message, MONITOR_EVIDENCE_MESSAGE_MAX);
}

/**
 * An event's raw tags → the tags the context carries. Drops every
 * user-identifying key, every entry that is not a `{ key: string, value: string }`,
 * truncates each value to {@link MONITOR_EVIDENCE_TAG_VALUE_MAX}, and keeps the
 * first {@link MONITOR_EVIDENCE_TAGS_MAX} in the order given. Anything that is
 * not an array is no tags at all.
 */
export function filterEvidenceTags(raw: unknown): NormalizedMonitorTag[] {
  if (!Array.isArray(raw)) return [];
  const kept: NormalizedMonitorTag[] = [];
  for (const entry of raw) {
    if (kept.length >= MONITOR_EVIDENCE_TAGS_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || !key || typeof value !== 'string') continue;
    if (isUserIdentifyingTagKey(key)) continue;
    kept.push({ key, value: boundEvidenceText(value, MONITOR_EVIDENCE_TAG_VALUE_MAX) });
  }
  return kept;
}

/**
 * A request URL → its PATH ONLY: no scheme, host, query string or fragment,
 * bounded by {@link MONITOR_EVIDENCE_PATH_MAX}. Accepts an absolute URL or a
 * relative one; anything that does not parse, or is not a non-empty string, is
 * `null` rather than a guess.
 */
export function requestPathOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let pathname: string;
  try {
    // The base only anchors a RELATIVE url; its host is discarded with the rest.
    pathname = new URL(url, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
  return boundEvidenceText(pathname, MONITOR_EVIDENCE_PATH_MAX);
}
