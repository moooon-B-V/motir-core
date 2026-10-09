import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeLateChangeService } from '@/lib/services/planChangeLateChangeService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';

// POST /api/ai/plan-change/session/late-changes — turn the changes STRANDED in a
// finished run's mailbox into ONE revision of its plan (Story MOTIR-7990 ·
// MOTIR-7997).
//
// A change forwarded while the job was still `running` but its walk was over
// (validating and closing the plan) was ACCEPTED by the mailbox, yet nothing is
// left to read it. The rail calls this once when a planning run's stream ends and
// it still lists a forwarded turn it never saw read. Answers:
//
//   { outcome: 'none' }                                    nothing was stranded
//   { outcome: 'revised', planId, revisionJobId, texts }   ONE REVISE_PLAN revision
//   { outcome: 'refused', code, texts, planStatus? }       the texts go back
//
// A refusal carries every claimed text, so nothing is dropped silently. A
// `runJobId` that is not the addressed session's run is a 404 (the mailbox's
// no-existence-leak mismatch) before anything is claimed or submitted.
//
// HTTP only (CLAUDE.md 4-layer): parse the body, call the service, map typed
// errors. NOT rate-limited, on the same reasoning as the sibling `mailbox` route:
// the claim is a database write, and the one AI submit behind it is a revision the
// shipped revise door already guards (lease, credits).
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bag = (body ?? {}) as Record<string, unknown>;
  const sessionId = readSessionId(bag['sessionId']);
  if (!sessionId) return missingSessionId();
  const runJobId = bag['runJobId'];
  if (typeof runJobId !== 'string' || runJobId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`runJobId` is required.' },
      { status: 400 },
    );
  }

  try {
    const texts = await planChangeLateChangeService.claimStranded(runJobId, sessionId, ctx);
    if (texts.length === 0) {
      return NextResponse.json(
        { outcome: 'none' },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const result = await planChangeLateChangeService.reviseLate(
      { sessionId, runJobId, texts },
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
