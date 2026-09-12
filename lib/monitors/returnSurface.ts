// WHERE A MONITOR CONNECT FLOW RETURNS TO (Story MOTIR-4926 · MOTIR-5260).
//
// ⚠️ THE RETURN TARGET IS AN ID, NEVER A PATH — and that is the whole security
// design rather than a stylistic choice. `lib/github/returnSurface.ts` states the
// argument in full and this module is the same shape one provider over: a
// redirect target resolved from a string that reached us from outside is an open
// redirect, and every mitigation for one (scheme checks, `//` checks, host
// allow-lists, normalisation) is a filter somebody has to get exactly right. An
// ID cannot express an absolute URL, a protocol-relative URL, a backslash, a
// userinfo `@`, or a path traversal: `resolveMonitorReturnPath` is a lookup in
// the frozen map below, and anything absent from it resolves to the default.
// There is no string to sanitise because there is no string.
//
// ONE carrier, not two. The GitHub module has two because its App install starts
// from a bare `github.com/apps/…` URL where no cookie can be set. This flow
// always starts with a request to Motir — the Connect button posts here so a
// cookie can be set — so the origin rides in the httpOnly state cookie beside
// the CSRF nonce and never takes the round trip at all. A value that never
// leaves this server cannot be tampered with on the way back.

/** Every surface a monitor connect flow may return to, id → in-app path. */
export const MONITOR_RETURN_SURFACES = {
  /** Settings → Project → Monitoring — the room this story's UI card builds
   *  (MOTIR-5262 draws and implements it). Registered here rather than later
   *  because the two halves of a return belong in one map. */
  projectMonitoring: '/settings/project/monitoring',
} as const;

export type MonitorReturnSurfaceId = keyof typeof MONITOR_RETURN_SURFACES;

/** Where a flow lands when it carries no origin, or one we do not recognise. */
export const DEFAULT_MONITOR_RETURN_PATH = MONITOR_RETURN_SURFACES.projectMonitoring;

const SURFACE_IDS = new Set<string>(Object.keys(MONITOR_RETURN_SURFACES));

/** Narrow an untrusted string to a known surface id, or `null`.
 *
 *  Everything that is not a key of the map is `null` — including an absolute
 *  URL, a protocol-relative URL, a path, and a path with traversal in it. The
 *  refusal is a set membership test, so it cannot be defeated by an encoding the
 *  way a prefix or scheme check can. */
export function parseMonitorReturnSurfaceId(
  value: string | null | undefined,
): MonitorReturnSurfaceId | null {
  if (typeof value !== 'string' || !SURFACE_IDS.has(value)) return null;
  return value as MonitorReturnSurfaceId;
}

/** The in-app path a flow returns to. Anything unrecognised — absent, unknown,
 *  or an attempt at a URL — resolves to {@link DEFAULT_MONITOR_RETURN_PATH}. */
export function resolveMonitorReturnPath(value: string | null | undefined): string {
  const id = parseMonitorReturnSurfaceId(value);
  return id ? MONITOR_RETURN_SURFACES[id] : DEFAULT_MONITOR_RETURN_PATH;
}
