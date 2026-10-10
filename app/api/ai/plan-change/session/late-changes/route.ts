import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
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
// errors. RATE-LIMITED on the `ai:generate` bucket, like the revise door it
// reuses: the revision it submits spends provider money. The limit is spent BEFORE
// the claim, so a 429 leaves every stranded turn unclaimed for the next call.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

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
