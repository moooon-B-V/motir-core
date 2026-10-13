import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planSessionResumeService } from '@/lib/services/planSessionResumeService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/plan-change/session/resume — RESUME a failed hosted planning session
// (Story MOTIR-7905 · MOTIR-7916).
//
// Starts a new motir-ai attempt on the SAME plan in the SAME session and returns `{ jobId,
// planId, session }`; the client streams `jobId` through the relay it already uses for that
// session (`/api/ai/augment/[jobId]/stream` streams ANY job id the caller may plan on), so a
// resumed job needs no new relay. One door for both Resume buttons — the To resume entry and
// the overlay.
//
// HTTP only (CLAUDE.md 4-layer): one service call, typed errors mapped — including the
// metered-AI ones (402 out-of-credits / 502 transport) a submit can raise, and the resume's own
// refusals (`NOT_SESSION_OWNER`, `SESSION_NOT_FAILED`, `RESUME_ALREADY_STARTED`,
// `PLAN_NOT_RESUMABLE`).
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // The AI ceiling, exactly as the sibling submit door: a resume spends credits, so the 429 is
  // answered before the body is read and long before the provider is called.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const sessionId = readSessionId((body as { sessionId?: unknown })?.sessionId);
  if (!sessionId) return missingSessionId();

  try {
    const result = await planSessionResumeService.resume(ctx, sessionId);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
