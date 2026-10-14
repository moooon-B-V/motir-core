import type { Event } from '@sentry/nextjs';

// A SPAN THAT OUTLIVES ITS REQUEST IS NOT SENT AS A TRANSACTION OF ITS OWN
// (MOTIR-8567).
//
// A streaming route's transaction ends when its handler RETURNS the `Response`,
// not when the response ends. The poll loop inside the `ReadableStream` keeps
// running in that ended span's async context, and `@sentry/opentelemetry`'s
// exporter sends any finished span whose parent was already sent as a root
// transaction, marking it `sentry.parent_span_already_sent`. The observability
// lane (MOTIR-8557) measured it: one open Workbench tab sent 2,087 such
// transactions in about 37 s — one per Prisma span per one-second watermark
// poll. In production that is a quota flood at any sampled rate, from every
// polling stream route at once.
//
// So they are dropped here, in the one hook every Node transaction passes,
// rather than in each of the twelve streaming routes. Nothing is lost for
// diagnosis: the request's own transaction still arrives whole, and the
// every-request wait/hold recorder (MOTIR-8553) counts each poll's database
// work in Prometheus without reading a span.

/** The trace-data flag the exporter sets on a span sent after its parent. */
export const PARENT_ALREADY_SENT_ATTR = 'sentry.parent_span_already_sent';

/** Null for a transaction made of spans that outlived their already-sent parent. */
export function dropOrphanedSpanTransactions<E extends Event>(event: E): E | null {
  return event.contexts?.trace?.data?.[PARENT_ALREADY_SENT_ATTR] === true ? null : event;
}
