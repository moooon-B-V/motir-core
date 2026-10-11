import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiSharpenService } from '@/lib/services/aiSharpenService';
import { noActiveProject } from '../../plan-change/_errors';
import { mapSharpenError, NO_STORE } from '../_errors';

// GET /api/ai/sharpen/[sessionId] — one of the caller's Sharpen sessions in the
// active project (Task MOTIR-1101 · Subtask MOTIR-8181). Another person's
// session, or one of another project, is a 404. HTTP only.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const { sessionId } = await params;
  try {
    return NextResponse.json(await aiSharpenService.get(sessionId, ctx), { headers: NO_STORE });
  } catch (err) {
    const mapped = mapSharpenError(err);
    if (mapped) return mapped;
    throw err;
  }
}
