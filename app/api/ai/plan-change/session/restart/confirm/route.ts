import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import {
  mapPlanChangeError,
  missingSessionId,
  noActiveProject,
  readSessionId,
} from '../../../_errors';

// THE CONTROL — Plan something new pressed (Story MOTIR-7631 · MOTIR-7649;
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 3, A3.3). Appends the
// same fixed confirm the person's words produce to their own open session and
// returns the session; a confirm already pending returns it unchanged. Closes
// nothing. `ai:plan`-gated in the service. NOT rate-limited, deliberately: it
// submits no model job, so it spends nothing at the provider.
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
  const sessionId = readSessionId((body as { sessionId?: unknown })?.sessionId);
  if (!sessionId) return missingSessionId();

  try {
    const result = await planChangeSessionsService.requestRestartConfirm(ctx, { sessionId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
