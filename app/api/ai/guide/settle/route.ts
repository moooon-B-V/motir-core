import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { guideLandingService } from '@/lib/services/guideLandingService';
import { mapPlanChangeError, noActiveProject, readSessionId } from '../../plan-change/_errors';

// POST /api/ai/guide/settle — LAND a settled guide turn (Story MOTIR-7459 ·
// MOTIR-7470; `docs/decisions/conversation-turn-intent.md` AMENDMENT 2, A2.4).
//
// Body: { jobId, sessionId }. The client that watched the guide job's stream
// settle tells the server to read its result and land it, exactly as the ask
// settle does — and `POST /api/ai/ask/settle` with a guide session's id lands
// here too. REPLAYABLE: a second settle of the same job lands nothing and
// returns the thread as it stands.
//
// NOT rate-limited, deliberately: it submits no model job. The job was paid for
// at the guide door (`POST /api/ai/guide`, on the `ai:generate` bucket); this
// route only reads its result back and lands it.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors. No `db`, no `$transaction`, no `motir-ai` import.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = (raw ?? {}) as { jobId?: unknown; sessionId?: unknown };
  const sessionId = readSessionId(body.sessionId);
  if (typeof body.jobId !== 'string' || body.jobId.length === 0 || !sessionId) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`jobId` and `sessionId` are required.' },
      { status: 400 },
    );
  }

  try {
    const result = await guideLandingService.settle(body.jobId, ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
