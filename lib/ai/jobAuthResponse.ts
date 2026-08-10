import { NextResponse } from 'next/server';
import { JobAuthError, JobRateLimitedError } from '@/lib/ai/jobAuth';

// Typed-error → HTTP translation for the `/api/internal/ai/*` gate (Subtask
// 8.5.9 / MOTIR-1165), extracted from the ~15 routes that each hand-rolled the
// same `if (err instanceof JobAuthError) return …` block.
//
// It exists because the 429 could not be hand-rolled the same way: a refusal has
// to carry `Retry-After` and the `X-RateLimit-*` triple, and fifteen copies of
// that is fifteen chances for one of them to answer a limited caller with a bare
// status and no way to know when to come back. The limiter builds the whole
// response once (`rateLimitedResponse`), the error carries it, and this returns
// it untouched.
//
// Returns null for anything else, so a route rethrows an unrecognised error as a
// genuine 500 exactly as before.

export function mapJobRequestError(err: unknown): Response | null {
  // The limiter already shaped the refusal, headers included — pass it through
  // rather than rebuilding it and risking a header being dropped.
  if (err instanceof JobRateLimitedError) return err.response;
  if (err instanceof JobAuthError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
  }
  return null;
}
