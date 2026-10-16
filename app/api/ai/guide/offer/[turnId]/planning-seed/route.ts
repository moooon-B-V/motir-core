import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { planningSeedService } from '@/lib/services/planningSeedService';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import type { PlanningGuideSeedReadDTO } from '@/lib/dto/planningSeed';

// GET /api/ai/guide/offer/[turnId]/planning-seed (story MOTIR-8684 · MOTIR-8692;
// decision MOTIR-8685) — the GUIDE-OFFER SEED the planning overlay opens with: the
// offer's resolved target to anchor on and the guide's request, VERBATIM, to send
// once on Confirm. The twin of `GET /api/approval-gates/[id]/planning-seed`.
//
// ⚠️ ADDRESSED BY THE OFFER'S TURN ID, NEVER BY THE REQUEST'S TEXT: the text would
// leak into history, logs and referrers from a URL, and a link anyone can edit could
// make Motir claim the guide said something it did not.
//
// Session-authed through the ACTIVE project: the no-project arm, the 2FA hold, then
// ONE service call. Every "nothing here for you" — an unknown turn, another member's
// guide conversation, a declined or superseded offer, a card the viewer cannot
// browse — is the SAME 404 body, never a 403. It submits no model job: NOT rate-limited, deliberately.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): no `db`, no transaction, no logic.

const NOT_FOUND = { code: 'NOT_FOUND' } as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const active = await getActiveProject();
  if (!active) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(active.userId);
  if (hold) return hold;

  const { turnId } = await params;
  try {
    const seed = await planningSeedService.getGuidePlanningSeed(turnId, active);
    const body: PlanningGuideSeedReadDTO = { seed };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof PlanningSeedNotFoundError) {
      return NextResponse.json(NOT_FOUND, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    /* v8 ignore next -- the RE-THROW: every "nothing here" is the typed error
       above; anything else is a real fault for Next's error boundary. */
    throw err;
  }
}
