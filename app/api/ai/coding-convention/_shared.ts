import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext } from '@/lib/projects';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { MotirAiError } from '@/lib/ai/errors';

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
// then a motir-ai boundary failure → 502 (the surface's error/retry state). An
// unknown error rethrows to a genuine 500.
export function mapCodeHealthError(err: unknown): NextResponse {
  const mapped = projectErrorResponse(err);
  if (mapped) return mapped;
  if (err instanceof MotirAiError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
  }
  throw err;
}

// Parse an optional non-negative-integer offset query param; absent/invalid →
// undefined (the service applies its default).
export function parseOffsetParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
