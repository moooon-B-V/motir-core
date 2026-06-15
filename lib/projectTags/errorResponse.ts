import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { InvalidProjectTagError, TooManyProjectTagsError } from '@/lib/projectTags/errors';

/**
 * Shared typed-error → HTTP mapping for the project-tags routes (Story 6.13 ·
 * Subtask 6.13.5), the `mapComponentError` pattern. Returns null for errors the
 * route should rethrow.
 *
 *   ProjectNotFoundError                          → 404 (hidden /
 *     cross-workspace ids are indistinguishable from never-existed ones —
 *     finding #26; the service has already converted browse-denials)
 *   NotProjectAdminError / ProjectAccessDeniedError → 403 (the 6.4 two-tier
 *     admin gate on the tagging write; a browser without manage/edit rights)
 *   InvalidProjectTagError / TooManyProjectTagsError → 422 (off-vocabulary slug
 *     or over the per-project cap)
 */
export function mapProjectTagError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof InvalidProjectTagError || err instanceof TooManyProjectTagsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
