// THE WATCHED-PLAN SET a Workbench stream carries (Story MOTIR-8542 · Subtask
// MOTIR-8730), and the plan frame it writes. Pure: no I/O, no client-only code,
// so the server parses with the same module the client encodes with.
//
// ⚠️ THE SET TRAVELS ON THE STREAM'S URL — `?watch=<planId>:<reviewVersion>`,
// repeated — and nowhere else. The app runs on several machines, so a separate
// call registering plans against a stream id could land on a machine that does
// not hold the stream; the query string is read by the instance that holds it
// and dies with it. A tab whose set changes closes its stream and opens another.
//
// ⚠️ THE FRAME IS A SIGNAL: a plan id and its review version, nothing else. The
// client's own review read decides what changed and what the reader may see.

/** The frame a stream writes when a watched plan's review version moved. */
export const WORKBENCH_STREAM_PLAN_FRAME = 'plan';

/** The most plans one stream may watch. More is a 400 before the stream opens. */
export const WORKBENCH_STREAM_MAX_WATCHED_PLANS = 10;

/** The query parameter each watched plan is carried in. */
export const WORKBENCH_STREAM_WATCH_PARAM = 'watch';

/** What a plan frame carries — exactly these two keys. */
export interface WorkbenchStreamPlanFrame {
  planId: string;
  reviewVersion: string;
}

/** One watched plan, and the review version the client already holds (null for none). */
export interface WatchedPlan {
  planId: string;
  version: string | null;
}

const PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A review version is `rv1.<hex>` today; the shape is kept open to a later
// prefix, and bounded so a hostile URL cannot carry a long string into a compare.
const VERSION = /^[A-Za-z0-9._-]{0,128}$/;

/**
 * Parse every `watch` parameter into the watched set. Answers `{ error }` for a
 * malformed entry, a bad plan id or a set larger than
 * {@link WORKBENCH_STREAM_MAX_WATCHED_PLANS}. A plan named twice is kept once,
 * with its first version. No `watch` parameter is the empty set.
 */
export function parseWatchParams(params: URLSearchParams): WatchedPlan[] | { error: string } {
  const plans: WatchedPlan[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll(WORKBENCH_STREAM_WATCH_PARAM)) {
    const colon = raw.indexOf(':');
    if (colon < 0) return { error: `a watch entry must be <planId>:<reviewVersion>` };
    const planId = raw.slice(0, colon);
    const version = raw.slice(colon + 1);
    if (!PLAN_ID.test(planId)) return { error: 'a watch entry names an invalid plan id' };
    if (!VERSION.test(version)) return { error: 'a watch entry carries an invalid review version' };
    if (seen.has(planId)) continue;
    seen.add(planId);
    plans.push({ planId, version: version === '' ? null : version });
  }
  if (plans.length > WORKBENCH_STREAM_MAX_WATCHED_PLANS) {
    return { error: `a stream may watch at most ${WORKBENCH_STREAM_MAX_WATCHED_PLANS} plans` };
  }
  return plans;
}

/**
 * The query fragment for a watched set — `watch=<id>%3A<version>&…`, without a
 * leading `?` or `&`. Empty for an empty set.
 */
export function formatWatchParams(plans: readonly WatchedPlan[]): string {
  const params = new URLSearchParams();
  for (const plan of plans) {
    params.append(WORKBENCH_STREAM_WATCH_PARAM, `${plan.planId}:${plan.version ?? ''}`);
  }
  return params.toString();
}
