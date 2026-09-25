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
 * Imports nothing, so the probe can load it in every DB-backed file for free.
 */

const pending = new Set<Promise<unknown>>();

/** Register a server-side promise the test's client may not await. Returns it unchanged. */
export function trackServerWork<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
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
 */
export async function settleServerWork(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
