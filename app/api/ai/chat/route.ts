import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiChatService } from '@/lib/services/aiChatService';
import { MotirAiError } from '@/lib/ai/errors';

// POST /api/ai/chat (Subtask 7.3.4) — submit a user turn into the onboarding
// `discovery` job for the active project, and return its `jobId`. The 7.3.5 chat
// UI then opens `GET /api/ai/chat/:jobId/stream` to read the reply live.
//
// Thin HTTP layer over aiChatService (CLAUDE.md 4-layer): the route reads the
// session (getSession → 401) + the active-project context (getActiveProject,
// the project analogue of getSession — mirrors /api/board), parses the body,
// calls ONE service method, and maps typed errors to status codes. No `db` / no
// `$transaction` / no `motir-ai` import here — the open-core boundary lives in
// the `server-only` client the service calls.
//
// Project comes from the active-project context (server-resolved within the
// actor's workspace), never the client — so a cross-tenant project is
// unreachable here (it's the user's OWN active project); a null context is
// simply "no active project" → 404 (the no-existence-leak shape, finding #26).

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
  const rawPrompt = (body as { prompt?: unknown })?.prompt;
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
  if (!prompt) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`prompt` is required.' },
      { status: 400 },
    );
  }

  try {
    const { jobId } = await aiChatService.submitDiscoveryTurn(prompt, ctx);
    return NextResponse.json({ jobId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // Any motir-ai-side failure (unreachable / misconfigured / rejected
    // envelope) maps through the 7.1.1 taxonomy to a typed error → 502: the
    // upstream dependency failed, not the caller's request.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
