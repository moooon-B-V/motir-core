import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// The public project's own SUBJECT (MOTIR-3945) — name, key, workspace, the
// authored hero (tagline + tags + README) and the computed stats, as
// `PublicProjectOverviewDto`.
//
// ── Why this route did not exist, and why it does now ──────────────────────
//
// Every LIST a public project page renders already had an endpoint beside this
// one — `tree`, `items`, `roadmap`, `changelog` — and the page's own SUBJECT did
// not: `app/(public)/p/[identifier]/page.tsx` reads it straight through
// `getPublicOverview`, because until now the only renderer lived in this
// repository and could call the service directly. A second renderer
// (`motir-marketing`, on `motir.co` — `docs/decisions/public-surface-hosts.md`)
// can fetch a project's work items and never learn its name. This closes that.
//
// ── Posture: anonymous, exactly like the four reads beside it ──────────────
//
// NOT session-gated on READ. The session is read only to PERSONALISE — it
// resolves `actorUserId`, which the service uses to decide member-visibility
// (the epic-privacy exclusion) and to report `canManage` for the in-place
// editor. An anonymous caller gets a valid response with `canManage: false`.
// Authorisation is the service's `resolvePublicProject` gate, which throws
// `ProjectNotFoundError` for a non-public or unknown key — a 404 with no
// existence leak, so a private project carrying the same key in another
// workspace stays hidden.
//
// HTTP layer only: parse → one service call → map errors (the 4-layer rule).
// The response shape is `PublicProjectOverviewDto` and is deliberately the SAME
// projection the page consumes — `tests/api/public-project-subject-route.test.ts`
// asserts that, so the contract cannot drift from what the page renders.

export async function GET(_req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  try {
    const overview = await publicProjectsService.getOverview(identifier, actorUserId);
    return NextResponse.json(overview);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
