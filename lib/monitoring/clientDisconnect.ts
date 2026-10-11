import type { ErrorEvent, EventHint } from '@sentry/nextjs';

// The signal filter for a CLIENT that left while a page was still streaming
// (MOTIR-8204).
//
// `GET /workbench` reported `Error: The destination stream closed early.` 14
// times in three days, with nothing but framework frames in its stack. That
// message is React's, not ours: `renderToPipeableStream(...).pipe(destination)`
// registers `destination.on('close', …)`, and when the destination closes before
// the render has finished it aborts the render with
// `new Error('The destination stream closed early.')` and hands that error to
// `onError` once for every Suspense boundary still pending. Next pipes React into
// a `PassThrough` and tears that down when the HTTP response closes — which, for
// a response still streaming, means the browser went away: a tab closed, a link
// clicked before the late boundaries arrived, a client navigation that cancelled
// the RSC fetch. `/workbench` streams its tab lists behind `<Suspense>`
// (MOTIR-7831), so it is the page that has late content to abandon.
// Reproduced in `tests/monitoring/clientDisconnect.test.ts` through Next's own
// `renderToNodeFizzStream` and `pipeNodeReadableToNodeResponse` over a real
// socket.
//
// ⚠️ NEXT ALREADY DECIDED THIS IS NOT AN ERROR — IT JUST DOES NOT RECOGNISE IT.
// Its render error handlers open with `if (isAbortError(err)) return; // If the
// response was closed, we don't need to log the error.` (`create-error-handler`),
// but `isAbortError` matches only `name === 'AbortError'` or Next's own
// `ResponseAborted`. React's cancel error is a plain `Error`, so it falls through
// to `onRequestError` and Sentry. This filter applies Next's own policy to the
// one disconnect it misses; it does not invent a new one.
//
// ⚠️ THE MATCH IS THE EXACT MESSAGE ON A PLAIN `Error`, AND NOTHING WIDER. The
// string is React's wording, raised from one place, and nothing in this
// repository produces it. Its sibling, `The destination stream errored while
// writing data.`, is deliberately NOT matched: that one means the destination
// was destroyed WITH an error, which is a fault somewhere in the pipeline, not a
// visitor leaving. A boundary that never resolves still shows on the request's
// own trace as a long transaction; dropping the echo hides nothing that trace
// does not already say.

/** React's reason for aborting a render whose destination closed under it. */
export const DESTINATION_CLOSED_EARLY = 'The destination stream closed early.';

/** True when `err` is React's abort for a destination that closed mid-render. */
export function isClientDisconnectAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'Error' && err.message === DESTINATION_CLOSED_EARLY;
}

/**
 * A Sentry `beforeSend` that drops React's abort for a client that disconnected
 * mid-stream, and passes everything else through untouched.
 */
export function dropClientDisconnectAborts(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  return isClientDisconnectAbort(hint.originalException) ? null : event;
}
