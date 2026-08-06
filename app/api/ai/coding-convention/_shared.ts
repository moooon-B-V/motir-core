import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext } from '@/lib/projects';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { MotirAiError } from '@/lib/ai/errors';
import { CodeHealthError } from '@/lib/codeHealth/errors';

// Shared plumbing for the /api/ai/coding-convention/* routes (MOTIR-926). Each
// route operates on the ACTIVE project (the /code-health page is active-project
// scoped, like /ready + /reports); the project-admin gate + cross-tenant 404 live
// in aiConventionService. These keep the four handlers thin one-service-call
// transports.

// Resolve the active-project context, or the 401/404 Response to return. A signed-
// out caller is 401; a signed-in caller with no active project is 404 (the island
// only calls these after the page rendered with a project, so this is an edge).
export async function resolveActiveProjectContext(): Promise<
  { ctx: ProjectContext } | { response: NextResponse }
> {
  const ctx = await getActiveProject();
  if (ctx) return { ctx };
  const session = await getSession();
  return {
    response: NextResponse.json(
      { code: session ? 'NO_ACTIVE_PROJECT' : 'UNAUTHENTICATED' },
      { status: session ? 404 : 401 },
    ),
  };
}

// Map a thrown error to its HTTP response: the project gate errors
// (ProjectNotFoundError → 404, NotProjectAdminError → 403) via the shared mapper,
// then a code-health domain error → 422, then a motir-ai boundary failure → 502
// (the surface's error/retry state). An unknown error rethrows to a genuine 500.
//
// The 422 arm (MOTIR-2247) carries the repo-scope rejections: the body parsed and
// the caller is authorized, but the VALUE it named is wrong (a repo the project is
// not connected to, or an explicitly empty target set). That is the same line
// `projectErrorResponse` already draws between 422 and 400 — a body that is not
// parseable at all is answered 400 by the route, before the service is reached.
export function mapCodeHealthError(err: unknown): NextResponse {
  const mapped = projectErrorResponse(err);
  if (mapped) return mapped;
  if (err instanceof CodeHealthError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  throw err;
}

// The outcome of reading the refresh route's OPTIONAL repo-scope body
// (MOTIR-2247). `ok: false` is a malformed body — the route answers 400 without
// reaching the service.
export type RepoScopeParse = { ok: true; repoKeys: string[] | undefined } | { ok: false };

// Read `POST /api/ai/coding-convention/refresh`'s optional `{ repoKeys }` body.
//
// **An ABSENT body must keep meaning "every connected repo", forever** — that is
// exactly what the shipped island sends (`fetch(REFRESH_URL, { method: 'POST' })`
// — no body, no content-type), so an empty request is `repoKeys: undefined`, not a
// parse failure. A body that IS present and unparseable is a 400; the route never
// silently downgrades one to a whole-set fan-out, which would spend N derivations
// on a client bug.
//
// An EMPTY array is passed THROUGH to the service, which rejects it (422). It is a
// well-formed request naming zero targets — a different failure from a malformed
// one, and the distinction is the point: a client that computes zero targets must
// not look like one that meant "everything".
export async function parseRepoScopeBody(req: Request): Promise<RepoScopeParse> {
  // A body that cannot be READ is malformed, NOT absent. Swallowing the failure
  // into `''` would read an unreadable request as "no scope" — i.e. answer a
  // broken request by deriving every connected repo, the exact spend this card
  // exists to stop. A genuinely bodyless POST resolves to `''` and never throws.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false };
  }
  if (raw.trim() === '') return { ok: true, repoKeys: undefined };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };

  // An explicit `null` reads as "no scope" — JSON serializers emit it for an
  // absent optional, and the whole-set fan-out is the safe reading of "unset".
  const value = (body as Record<string, unknown>)['repoKeys'];
  if (value === undefined || value === null) return { ok: true, repoKeys: undefined };
  if (!Array.isArray(value)) return { ok: false };
  if (!value.every((key) => typeof key === 'string' && key.trim() !== '')) return { ok: false };
  return { ok: true, repoKeys: value as string[] };
}

// Parse an optional non-negative-integer offset query param; absent/invalid →
// undefined (the service applies its default).
export function parseOffsetParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// Parse an optional POSITIVE-integer findings limit; absent/invalid → undefined
// (the service applies its page size). Distinct from the offset above: this one
// is 1-BASED, because motir-ai's `parsePositiveInt` rejects `0` outright — so a
// `?findingsLimit=0` that slipped through here would be a 502, not a cheap read.
// Used by the audit tab's per-repo SUMMARY reads (MOTIR-2207 · Panel 7 §3).
export function parseLimitParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}
