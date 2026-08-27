import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiChatService } from '@/lib/services/aiChatService';
import { MotirAiError } from '@/lib/ai/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

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
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  // The shared AI ceiling (8.5.9 / MOTIR-1165), keyed on workspace + user because
  // what is being protected is the model-provider bill, not capacity. Spent
  // before the body is parsed and long before the job is submitted — a 429 after
  // the provider call would have already spent the money.
  const limited = await enforceAiRateLimit(ctx, 'ai:chat');
  if (limited) return limited;

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
    // MOTIR-2355 — the `ai:plan` gate. A non-browser is the 404 (no existence
    // leak); a browser without the key is the 403 that names it.
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message, permission: err.permission },
        { status: 403 },
      );
    }
    throw err;
  }
}
