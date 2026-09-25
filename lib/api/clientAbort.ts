// Reading a request body whose sender has already hung up (MOTIR-6256).
//
// `await req.text()` rejects when the connection closes before the handler has
// read the whole body. On Node that rejection is the request stream's own
// destroy error — `Error: aborted`, `code: 'ECONNRESET'`, raised by
// `abortIncoming` in `node:_http_server` when the socket closes with the
// request still open — and it rejects whether the sender stopped MID-BODY or
// sent every byte and then gave up while the request waited for its handler.
// Unhandled, a route re-throws it and Next reports it through `onRequestError`
// as a server fault: an error-level monitor event with no application frame.
//
// It is not a server fault. The client is gone, nothing it sent can be
// authenticated or processed, and no answer will be read. What the route owes is
// to stop quietly and say what was lost — which only the route knows (a webhook's
// delivery id and event name live in its headers), so recognising the abort is
// here and the log line is the caller's.
//
// ⚠️ THE TEST IS NARROW ON PURPOSE. It matches the one shape Node gives a
// departed client, an `AbortError`, or a request whose own signal has fired —
// never "any error from a body read". A read that fails for any other reason is
// a real fault and still propagates to the monitor.

/** True when `err` is what a body read throws because the CLIENT closed the
 *  connection — not a fault in the server. */
export function isClientAbort(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return err.message === 'aborted' && (err as NodeJS.ErrnoException).code === 'ECONNRESET';
}

/** The status a route answers once its client has gone: nginx's "client closed
 *  request". Nobody reads it; it exists so an access log does not record a 2xx
 *  for a request that was never processed. */
export const CLIENT_CLOSED_REQUEST_STATUS = 499;

/**
 * The raw body, or `null` when the client closed the connection before it could
 * be read. Any other read failure is re-thrown.
 */
export async function readRawBodyUnlessAborted(req: Request): Promise<string | null> {
  try {
    return await req.text();
  } catch (err) {
    if (isClientAbort(err, req.signal)) return null;
    throw err;
  }
}
