import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject } from '../_errors';

// POST /api/ai/plan-change/session — open the active project's plan-change
// CONVERSATION, or RESUME the existing one (Story 7.30 · MOTIR-1728). The rail
// calls this on mount; the response carries the full ordered thread, so a
// reopened workspace continues the conversation instead of starting over.
//
// POST (not GET) because it get-or-CREATEs; it is idempotent — there is one
// thread per project and a second call returns the same one.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors.
export async function POST(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  try {
    const result = await planChangeSessionsService.getOrCreateForProject(ctx);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
