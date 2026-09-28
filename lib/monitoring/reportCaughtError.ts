'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

// Report an error that one of motir-core's ERROR BOUNDARIES caught
// (MOTIR-6855 · Bug MOTIR-6776).
//
// ⚠️ A CAUGHT ERROR NO LONGER REACHES SENTRY ON ITS OWN. Before these boundaries
// existed a server render failure reached Next's `onUncaughtError`, which
// Sentry's global handler reports. Once `error.tsx` catches it, Next routes it
// to `onCaughtError` instead, which in a production build only
// `console.error`s it (`next/dist/client/react-client-callbacks/
// error-boundary-callbacks.js`) — and this app does not capture the console.
// Without this call the boundary would TRADE a visible crash for a silent one,
// which is worse than the crash.
//
// The `digest` tag is what matches the browser event to its server twin: a
// Server Component error reaches the client with its message stripped and a
// digest in its place, and `instrumentation.ts`'s `onRequestError` has already
// reported the real server exception.

/** Which boundary caught it — the depth it failed at (design MOTIR-6854's states 1–3). */
export type ErrorBoundaryName = 'authed-page' | 'app' | 'global';

type DigestError = Error & { digest?: string };

// Exactly once per error INSTANCE, not once per effect run: a re-mount (React's
// dev double-invoke, a boundary re-rendering the same error) must not file the
// same failure twice. A retry that fails again throws a NEW instance, which is
// a new failure and is reported.
const reported = new WeakSet<Error>();

export function reportCaughtError(error: DigestError, boundary: ErrorBoundaryName): void {
  if (reported.has(error)) return;
  reported.add(error);
  Sentry.captureException(error, {
    tags: {
      boundary: `error-boundary:${boundary}`,
      ...(error.digest ? { digest: error.digest } : {}),
    },
  });
}

/** Report `error` once, after the boundary has committed its fallback. */
export function useReportCaughtError(error: DigestError, boundary: ErrorBoundaryName): void {
  useEffect(() => {
    reportCaughtError(error, boundary);
  }, [error, boundary]);
}
