import { NextResponse } from 'next/server';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { PageBodyTooLargeError, PageNotFoundError, PageTitleTooLongError } from '@/lib/pages';

// The page routes' refusal map (Story MOTIR-5752 · MOTIR-7278) — the same shape
// as `lib/workItems/gateResponse.ts`: one function every `/api/pages` handler's
// catch block calls, so the four doors cannot disagree about a status.
//
// ⚠️ A NON-MEMBER AND AN UNKNOWN PAGE GET THE SAME BYTES. `pagesService` refuses
// a caller who cannot browse the project as `ProjectAccessDeniedError('browse')`
// and a page from another project as `PageNotFoundError`; both answer the one
// body below, so neither a stranger nor a member of project A learns whether a
// page id exists. (`ProjectNotFoundError` — a foreign or token-narrowed project —
// is the same case one layer down.)

/** The not-found body, built once so every arm that answers 404 sends it verbatim. */
export function pageNotFoundResponse(): NextResponse {
  return NextResponse.json({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' }, { status: 404 });
}

/** A body over the save cap — the route's own pre-read refusal uses it too. */
export function pageBodyTooLargeResponse(limit: number, size: number): NextResponse {
  const err = new PageBodyTooLargeError(limit, size);
  return NextResponse.json(
    { code: err.code, error: err.message, limit: err.limit, size: err.size },
    { status: 413 },
  );
}

/** Map a page refusal to HTTP, or rethrow anything that is not one. */
export function pageErrorResponse(err: unknown): NextResponse {
  if (err instanceof ProjectAccessDeniedError) {
    if (err.kind === 'browse') return pageNotFoundResponse();
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof ProjectNotFoundError || err instanceof PageNotFoundError) {
    return pageNotFoundResponse();
  }
  if (err instanceof PageBodyTooLargeError) return pageBodyTooLargeResponse(err.limit, err.size);
  if (err instanceof PageTitleTooLongError) {
    return NextResponse.json(
      { code: err.code, error: err.message, limit: err.limit },
      { status: 422 },
    );
  }
  throw err;
}
