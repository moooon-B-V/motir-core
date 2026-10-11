import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { ServerResponse } from 'node:http';

// A Node HTTP response may carry more `close` listeners than the emitter default
// of 10 (MOTIR-8171).
//
// Production `fly logs` showed `MaxListenersExceededWarning: 11 close listeners
// added to [ServerResponse]` dozens of times an hour on both machines. Node
// prints that warning once PER EMITTER, so each line is a different response:
// a per-request fan-out, not one emitter growing across requests.
//
// ⚠️ NOTHING IN THIS REPOSITORY ADDS THEM. The listeners come from the framework
// stack, each subscribing once per response, measured on a throwaway Next 16.3.6
// + @sentry/nextjs 10.71.0 app (`listenerCount('close')` at `res.end()`):
//
//   Next's router-server, its request-signal abort controller, the app-page
//   renderer's three `onClose` registrations and `pipeToNodeResponse` — 6 on a
//   streamed page; Sentry's `recordRequestSession` and HTTP-server span
//   integration — +2; `proxy.ts` — +1. That is 8–9 on an ordinary page or route,
//   so the 11th needs only two more of the same kind (a route that reads
//   `request.signal`, a second streamed boundary, another Sentry integration).
//   Every one is bounded by the response's own lifetime and released when it
//   closes: this is not a leak.
//
// WHY RAISE THE LIMIT HERE AND NOT SILENCE THE WARNING: the warning stays
// useful for what it is for — a listener that really does pile up. So the limit
// is raised on each RESPONSE ONLY (never `EventEmitter.defaultMaxListeners`,
// never `setMaxListeners(0)`), to a ceiling that still trips on a genuine leak.
export const RESPONSE_CLOSE_LISTENER_LIMIT = 20;

const CHANNEL = 'http.server.response.created';

type ResponseCreated = { response: ServerResponse };

function onResponseCreated(message: unknown): void {
  (message as ResponseCreated).response.setMaxListeners(RESPONSE_CLOSE_LISTENER_LIMIT);
}

/**
 * Raise the listener ceiling on every HTTP server response, as it is created.
 * Idempotent: a second call subscribes nothing new (a repeated subscription of
 * the same function is a no-op in `diagnostics_channel`).
 *
 * `http.server.response.created` is published by Node's HTTP server while the
 * `ServerResponse` is built, before the request handler — and so before Next's
 * or Sentry's listeners — runs.
 */
export function installResponseCloseListenerLimit(): void {
  subscribe(CHANNEL, onResponseCreated);
}

/** Test seam: remove the subscription. */
export function uninstallResponseCloseListenerLimit(): void {
  unsubscribe(CHANNEL, onResponseCreated);
}
