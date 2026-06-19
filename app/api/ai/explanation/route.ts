import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiExplanationService } from '@/lib/services/aiExplanationService';
import { MotirAiError } from '@/lib/ai/errors';

// POST /api/ai/explanation (Subtask 8.8.12) — submit a `generate_explanation`
// job (8.8.11) for the active project from a work item's draft context, and
// return its `jobId`. The create-modal / edit-form "Draft with AI" UI then opens
// `GET /api/ai/explanation/:jobId/stream` to read the drafted markdown live.
//
// Thin HTTP layer over aiExplanationService (CLAUDE.md 4-layer), modelled on
// /api/ai/chat: read the session (→ 401) + the active-project context (→ 404),
// whitelist the body, call ONE service method, map typed errors. No `db` / no
// `motir-ai` import — the open-core boundary lives in the `server-only` client.

const MAX_TITLE_LENGTH = 200;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const title = asString(b['title']);
  if (!title) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`title` is required to draft an explanation.' },
      { status: 400 },
    );
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`title` is too long.' },
      { status: 400 },
    );
  }

  try {
    const { jobId } = await aiExplanationService.submitExplanationDraft(
      {
        title,
        description: asString(b['description']),
        type: asString(b['type']),
        parentKey: asString(b['parentKey']),
        parentTitle: asString(b['parentTitle']),
      },
      ctx,
    );
    return NextResponse.json({ jobId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // Any motir-ai-side failure (unreachable / misconfigured / rejected
    // envelope) maps through the 7.1.1 taxonomy to a typed error → 502.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
