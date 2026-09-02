import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// The public project's BOARD tab (MOTIR-4109) — its default board's columns,
// each with its mapped status keys, its public-safe cards and its full count, as
// `PublicBoardDto`.
//
// ── Why this route did not exist, and why it does now ──────────────────────
//
// `publicProjectsService.getBoard` has been shipped and tested since Story 6.14
// and NOTHING called it over HTTP: the only renderer was
// `app/(public)/p/[identifier]/board/page.tsx`, in this repository, reaching the
// service through Prisma. MOTIR-3951 deleted that page and kept the service
// method precisely for this card, and `motir.co` (`motir-marketing`) talks HTTP.
// So this is not new capability — it is the same read, through the door the new
// renderer has (`docs/decisions/public-surface-hosts.md` §2, §3).
//
// ── Posture: anonymous, exactly like the five reads beside it ──────────────
//
// NOT session-gated on READ. The session resolves `actorUserId`, which the
// service uses for member-visibility only — the epic-privacy exclusion, where a
// non-member never receives a private epic's descendants and sees that epic's
// own row marked `childrenHidden`. An anonymous caller gets a valid board.
// Authorisation is `resolvePublicProject`, which throws `ProjectNotFoundError`
// for a non-public or unknown key — 404 with no existence leak, so a private
// project carrying the same key in another workspace stays hidden.
//
// ⚠️ After AMENDMENT 3, `motir.co` is the caller and it is ALWAYS anonymous:
// the session cookie is host-only on `app.motir.co` and `sameSite: 'lax'`
// forecloses a credentialed cross-origin read regardless. `actorUserId` is
// structurally `null` for every call this route serves from the public site,
// which is why the projection it returns is identical for every visitor and
// cacheable at the edge with no `Vary: Cookie`.
//
// The read is BOUNDED by the service's own `PUBLIC_BOARD_CAP` and reports
// `truncated` rather than paging: a board is a whole-shape read, and the cap is
// the answer to "never load every row" (MOTIR-2789). There is no cursor here by
// design — the Items tab beside it is the paged surface.
//
// HTTP layer only: gate → session → one service call → map errors (the 4-layer
// rule, `motir-core/CLAUDE.md`).

export async function GET(_req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before the rate limit and before
  // any session read: with `MOTIR_CLOUD` unset this surface does not exist.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  try {
    const board = await publicProjectsService.getBoard(identifier, actorUserId);
    return NextResponse.json(board);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
