import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { PROJECT_SCOPE, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { mapPlanChangeError, noActiveProject, readSessionId } from '../_errors';

// /api/ai/plan-change/session — the active project's planning CONVERSATIONS
// (Story 7.30 · MOTIR-1728; addressed by id since MOTIR-6023 —
// `agent-authored-plans.md` AMENDMENT 17 §1–§3).
//
//   GET  ?id=<sessionId> → that session (browse). An id outside this project is
//                          404 `PLAN_SESSION_NOT_FOUND`.
//   GET  [?scope=<key>]  → the caller's own RESUMABLE session for the scope
//                          (default: the project-wide one), or `null`. A read:
//                          looking at the door creates nothing.
//   POST { body, isAnswer? } → START with the first turn — or, when the caller
//                          already has a resumable project-wide session, append
//                          to it (the service decides under a lock). This is the
//                          only way a conversation comes into existence.
//
// HTTP only (CLAUDE.md 4-layer): resolve the session + active project, call ONE
// service method, map typed errors.
// NOT rate-limited, deliberately (MOTIR-2597): no model job is submitted here.
// The AI ceiling guards the doors that SUBMIT.
export async function GET(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const params = new URL(req.url).searchParams;
  const id = readSessionId(params.get('id'));
  try {
    const result = id
      ? await planChangeSessionsService.getById(ctx, id)
      : await planChangeSessionsService.findResumable(
          ctx,
          params.get('scope') ?? PROJECT_SCOPE_KEY,
        );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}

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
  const rawBody = (body as { body?: unknown })?.body;
  if (typeof rawBody !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`body` — the first turn — is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await planChangeSessionsService.startWithFirstTurn(ctx, PROJECT_SCOPE, rawBody, {
      isAnswer: (body as { isAnswer?: unknown })?.isAnswer === true,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
