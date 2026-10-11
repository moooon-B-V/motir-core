import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiSharpenService } from '@/lib/services/aiSharpenService';
import { noActiveProject, readSessionId } from '../../plan-change/_errors';
import { badRequest, mapSharpenError, NO_STORE } from '../_errors';

// POST /api/ai/sharpen/settle — read a finished `sharpen_turn` job's result and
// store it on its session (Task MOTIR-1101 · Subtask MOTIR-8181). Body:
// { sessionId, jobId }. REPLAYABLE: `pending` until the job ends, and a second
// settle of the same job stores nothing.
//
// NOT rate-limited, deliberately: it submits no job — the same reasoning as the
// guide settle route. HTTP only.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest('Invalid JSON body.');
  }
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const sessionId = readSessionId(body.sessionId);
  if (typeof body.jobId !== 'string' || body.jobId.length === 0 || !sessionId) {
    return badRequest('`jobId` and `sessionId` are required.');
  }
  try {
    const result = await aiSharpenService.settle(sessionId, body.jobId, ctx);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    const mapped = mapSharpenError(err);
    if (mapped) return mapped;
    throw err;
  }
}
