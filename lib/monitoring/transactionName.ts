import type { Event } from '@sentry/nextjs';

// A ROOT NAME WE CHOSE SURVIVES NEXT'S OWN RENAME (MOTIR-8566).
//
// `@sentry/nextjs` registers a `preprocessEvent` hook (its
// `enhanceHandleRequestRootSpan`) that renames every `BaseServer.handleRequest`
// root to `${method} ${route}` AT EVENT TIME — after anything request code did
// with `Sentry.updateSpanName`. So an MCP call's root, renamed for its tool by
// `lib/mcp/toolTracing.ts` (MOTIR-8551), still reached Sentry as
// `POST /api/mcp`. Only a built server shows it: an in-process test never has
// Next's root span, so it passed.
//
// The name is therefore ALSO written to the root as an attribute, and the Node
// runtimes' `beforeSendTransaction` — which runs after every `preprocessEvent`
// hook and event processor — puts it back. Without a DSN nothing here runs.

/** The root-span attribute that carries the transaction name to restore. */
export const ROOT_NAME_ATTR = 'motir.root_name';

/** Put back a root name request code chose, if Next overwrote it. */
export function restoreChosenRootName<E extends Event>(event: E): E {
  const chosen = event.contexts?.trace?.data?.[ROOT_NAME_ATTR];
  if (typeof chosen !== 'string' || chosen === event.transaction) return event;
  event.transaction = chosen;
  event.transaction_info = { ...event.transaction_info, source: 'custom' };
  return event;
}
