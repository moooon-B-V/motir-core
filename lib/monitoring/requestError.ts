import * as Sentry from '@sentry/nextjs';

// The server half of the DIGEST join (Bug MOTIR-8214).
//
// A Server Component that throws reaches the browser with its message redacted
// and a `digest` in its place: React's "An error occurred in the Server
// Components render…" notice. The authed error boundary reports that browser
// event with the digest as a tag (`./reportCaughtError`), and its comment says
// the tag "is what matches the browser event to its server twin". It was not:
// `Sentry.captureRequestError` records the route, the method and the router
// kind, and never the digest. So the redacted client issue and the real server
// exception carried no value in common, and the only way to pair them was to
// line up timestamps by hand. MOTIR-6776 did that once; MOTIR-8214 had to do it
// again (its event at 16:01:55.814Z is MOTIR-8213's `reading 'owner'` throw at
// 16:01:55.606Z, same release, route and browser).
//
// Next stamps `digest` onto the thrown error BEFORE it calls `onRequestError`
// (`next/dist/server/app-render/create-error-handler.js`: the digest is
// assigned, then `onReactServerRenderError` runs), so the value is already on
// the error this hook receives. Tagging it here gives both events the same
// `digest` tag, and searching Sentry for the digest a user saw on the error page
// returns the server exception that produced it.
//
// It wraps `captureRequestError` rather than replacing it: the SDK still owns
// the request context, the transaction name and the flush. Its `withScope`
// forks the scope this one opens, so the tag set here rides into its event.

type RequestErrorArgs = Parameters<typeof Sentry.captureRequestError>;

/** The digest Next stamped on a thrown render error, or null when it carries none. */
export function digestOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.length > 0 ? digest : null;
}

/**
 * Next's `onRequestError` hook: report the server exception through the SDK,
 * tagged with the digest the browser was shown so the two events join.
 */
export function onRequestError(
  ...args: RequestErrorArgs
): ReturnType<typeof Sentry.captureRequestError> {
  const digest = digestOf(args[0]);
  if (digest === null) return Sentry.captureRequestError(...args);
  return Sentry.withScope((scope) => {
    scope.setTag('digest', digest);
    return Sentry.captureRequestError(...args);
  });
}
