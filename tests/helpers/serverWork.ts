/**
 * Server-side work a test STARTED but its client never awaited (MOTIR-6324).
 *
 * WHY IT EXISTS. The MCP SDK's `StreamableHTTPClientTransport` answers the
 * `notifications/initialized` 202 by opening its optional SSE stream — a GET
 * it starts and never awaits (`_startOrAuthSse(...).catch(...)` in
 * `@modelcontextprotocol/sdk` `client/streamableHttp.js`). Our route answers
 * that GET 405 (`disableSse: true`), but only after `withMcpAuth` has verified
 * the token (a `withSystemContext` transaction) and `enforceMcpRateLimit` has
 * spent one `mcp:call` (a `$transaction` INSERT into `rate_limit_counter`). In a
 * test that drives the route in-process, that GET is a request nobody is waiting
 * for: a short test — a strict-input refusal, a blank query — can end while it
 * is still inside one of those transactions, and the suite-wide in-flight probe
 * then fails that test on `BEGIN`, the counter `INSERT` or its `COMMIT`.
 *
 * So every harness that hands a request to a route handler in-process registers
 * the handler's promise here, and `inFlightProbe.ts` SETTLES them before it asks
 * the database what is still running. The work is awaited, not skipped: the GET
 * still runs the auth gate and the limiter, and anything a handler itself starts
 * without awaiting still outlives the settle and is still reported.
 *
 * THE SETTLE IS BOUNDED (MOTIR-6496). A tracked request that never settles —
 * a response stream whose client hung up, a handler waiting on a lock — used to
 * stay in the set for ever, so every LATER test's probe waited on it and failed
 * at the hook budget, naming nothing and blaming innocent tests. So the settle
 * gives up after `SETTLE_DEADLINE_MS`, fails the test it is running for with
 * the method, path and starting test of each request still pending, and DROPS
 * them, so the next test starts clean.
 *
 * Imports only `vitest` (for the running test's name), which every file that
 * loads the probe has already loaded.
 */
import { expect } from 'vitest';

/**
 * How long the probe waits for tracked work before failing the test. Well under
 * the 30 s `hookTimeout` (vitest.config.ts), which the settle shares with the
 * probe's database read.
 */
export const SETTLE_DEADLINE_MS = 10_000;

/** Each pending promise → what it is ("POST /api/mcp") and the test that started it. */
const pending = new Map<Promise<unknown>, string>();

/**
 * Register a server-side promise the test's client may not await. Returns it
 * unchanged. `label` names the request (method + path) in the deadline error.
 */
export function trackServerWork<T>(work: Promise<T>, label = 'untitled server work'): Promise<T> {
  const test = expect.getState().currentTestName;
  pending.set(work, test ? `${label} (started by "${test}")` : label);
  const done = () => {
    pending.delete(work);
  };
  work.then(done, done);
  return work;
}

/** How many tracked handlers have not settled yet. */
export function pendingServerWork(): number {
  return pending.size;
}

/**
 * Wait until every tracked handler has settled — including any a settling
 * handler registered on its way out. A rejection is the test's to report, not
 * this hook's, so it is settled rather than rethrown.
 *
 * Bounded: whatever is still pending after `deadlineMs` is dropped from the set
 * and reported in the error this throws, so it fails THIS test and no other.
 */
export async function settleServerWork(deadlineMs = SETTLE_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (pending.size > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = await Promise.race([
      Promise.allSettled([...pending.keys()]).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    if (expired) {
      const stuck = [...pending.values()];
      pending.clear();
      throw new Error(
        `${stuck.length} server request(s) this test started did not settle within ` +
          `${deadlineMs} ms, and were dropped so the next test starts clean ` +
          `(tests/helpers/serverWork.ts, MOTIR-6496):\n` +
          stuck.map((label) => `  - ${label}`).join('\n'),
      );
    }
  }
}
