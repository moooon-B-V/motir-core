import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { InvalidRoadmapCursorError } from '@/lib/publicProjects/roadmapCursor';
import { enforcePublicReadRateLimit } from '@/lib/rateLimit/publicReadGuard';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { publicRequestsService } from '@/lib/services/publicRequestsService';

// GET /api/p/[identifier]/requests?cursor= — the "Load more" door of a public
// project's Requested features, for its VISITOR (Story MOTIR-6171 · MOTIR-6768;
// `docs/decisions/public-request-board-retired.md` Decision 2). Page one is
// rendered server-side by the Visitor page; this serves every page after it.
//
// ⚠️ A VISITOR-ONLY door, and so unlike MOTIR-6647's data doors in ONE respect:
// those serve a member first and fall back to today's answer for anyone who is
// not the cookie's Visitor. This read has no member answer — a member reads the
// same list in their own inbox, with its acts — so each of `resolveVisitor`'s
// refusals is answered by name, in the resolver's own order:
//
//   not_found (cloud off, unknown, not public)  → 404, one indistinguishable answer
//   sign_in   (no session)                      → 401 VISITOR_SIGN_IN_REQUIRED
//   a two-factor hold on the session            → 403, the shared hold body
//   enter     (the reader can enter the project)→ 409 VISITOR_ENTERS_PROJECT, href
//   consent   (not yet consented)               → 403 VISITOR_CONSENT_REQUIRED
//   visitor, past the `public-read` budget      → 429, spent per person
//
// The budget is spent only on a `visitor` verdict, exactly as
// `resolveReadActor` spends it: a refused reader reads nothing. GET only — it
// writes nothing, so the write-door guard does not reach it.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ identifier: string }> },
): Promise<Response> {
  const { identifier } = await params;
  const cursor = new URL(req.url).searchParams.get('cursor') || undefined;

  const session = await getSession();
  const verdict = await projectAccessService.resolveVisitor(identifier, session);
  if (verdict.kind === 'not_found') {
    return NextResponse.json({ code: 'PROJECT_NOT_FOUND' }, { status: 404 });
  }
  if (verdict.kind === 'sign_in') {
    return NextResponse.json({ code: 'VISITOR_SIGN_IN_REQUIRED' }, { status: 401 });
  }
  // A signed-in reader held by the two-factor rule is no more a Visitor than a
  // member (`resolveReadActor` requires the same compliant session).
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  if (verdict.kind === 'enter') {
    return NextResponse.json(
      { code: 'VISITOR_ENTERS_PROJECT', href: '/requested-features' },
      { status: 409 },
    );
  }
  if (verdict.kind === 'consent') {
    return NextResponse.json({ code: 'VISITOR_CONSENT_REQUIRED' }, { status: 403 });
  }

  const limited = await enforcePublicReadRateLimit(req, verdict.ctx.actorUserId);
  if (limited) return limited;

  try {
    const page = await publicRequestsService.listPendingForVisitorContext(verdict.ctx, cursor);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof InvalidRoadmapCursorError) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    throw err;
  }
}
