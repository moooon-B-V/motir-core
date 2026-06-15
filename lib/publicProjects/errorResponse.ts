import { NextResponse } from 'next/server';
import { mapTriageSubmissionError } from '@/lib/triage/errorResponse';
import {
  PublicProjectIntakeUnavailableError,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
} from '@/lib/publicProjects/errors';

// Typed-error → HTTP-status translation for the public-project routes (Story
// 6.12 · Subtask 6.12.5: POST /api/public/projects/[projectId]/requests and its
// /duplicates pre-check). Composes the shared triage-intake mapper for every
// reused failure (a non-public project → 404 ProjectNotFoundError; a denied
// grant → 403 ProjectAccessDeniedError; a non-member reporter → 403; a bad
// kind / blank-or-over-long title → 422) and ADDS the public-only modes:
//
//   PublicSubmissionRateLimitedError            → 429 (+ Retry-After header)
//   PublicRequestDescriptionTooLongError        → 422 (the body size cap)
//   PublicProjectIntakeUnavailableError         → 409 (owner invariant broken)
//
// Returns null for an error neither mapper knows, so the route rethrows it as a
// genuine 500.
export function mapPublicProjectError(err: unknown): NextResponse | null {
  if (err instanceof PublicSubmissionRateLimitedError) {
    return NextResponse.json(
      { code: err.code, error: err.message },
      { status: 429, headers: { 'Retry-After': String(err.retryAfterSeconds) } },
    );
  }
  if (err instanceof PublicRequestDescriptionTooLongError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  if (err instanceof PublicProjectIntakeUnavailableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // Everything else (ProjectNotFound / access-denied / reporter-not-member /
  // invalid kind / invalid title) is the shared triage-intake surface.
  return mapTriageSubmissionError(err);
}
