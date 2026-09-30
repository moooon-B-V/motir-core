import type { Breadcrumb } from '@sentry/nextjs';
import { serverSentryInitOptions } from '@/lib/monitoring/serverInit';

// THE RELAY'S ERROR MONITORING (`docs/decisions/agent-terminal.md` Q8 ·
// MOTIR-6940): the same `serverSentryInitOptions()` every Node runtime uses
// (`sendDefaultPii: false`, null without a DSN — the self-host contract), plus a
// `beforeBreadcrumb` that drops every `console` breadcrumb in this process. The
// relay never logs a frame, but a breadcrumb trail is a second copy of whatever
// was logged, attached to the next event — so it is closed as a sink outright.

/** Drop console breadcrumbs; keep the rest (HTTP, navigation) unchanged. */
export function dropConsoleBreadcrumbs(breadcrumb: Breadcrumb): Breadcrumb | null {
  return breadcrumb.category === 'console' ? null : breadcrumb;
}

/** The relay's `Sentry.init` options, or null when monitoring is off. */
export function relaySentryInitOptions() {
  const options = serverSentryInitOptions();
  if (!options) return null;
  return { ...options, beforeBreadcrumb: dropConsoleBreadcrumbs };
}

/**
 * An error safe to report or log: a fixed context plus the original's NAME and,
 * when it has one, a short machine code (`P2028`, `ECONNREFUSED`). Never the
 * original message — the relay reports nothing it did not write itself, so no
 * frame, ticket or token can ride along in one.
 */
export function scrubbedError(context: string, err: unknown): Error {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? ` ${code}` : '';
  const scrubbed = new Error(`${context} (${name}${safeCode})`);
  scrubbed.name = 'TerminalRelayError';
  return scrubbed;
}
