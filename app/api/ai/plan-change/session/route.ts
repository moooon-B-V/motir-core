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
//   GET  [?scope=<key>]  → `{ session, earlier }`: the caller's own RESUMABLE
//                          session for the scope (default: the project-wide
//                          one), or `null` — and then the scope's most recent
//                          OTHER conversation for the fresh-start notice
//                          (MOTIR-6024). A read: looking creates nothing.
//   POST { body, isAnswer? } → START with the first turn — or, when the caller
//                          already has a resumable project-wide session, append
//                          to it (the service decides under a lock).
//   POST { copyFrom, body?, isAnswer?, anchorKey?, planId? }
//                        → START as a COPY of the caller's own ended session
//                          (AMENDMENT 23 §6; MOTIR-7641) — failed or idle-closed,
//                          or ended any way while a plan still waits, which moves
//                          with it (MOTIR-7930). With `body`, that is the new
//                          session's first turn, in the same transaction; a
//                          plan decided meanwhile is 409 `PLAN_SESSION_PLAN_DECIDED`.
//                          These are the only ways a conversation comes into
//                          existence.
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
      ? await planChangeSessionsService.getByIdForReader(ctx, id)
      : await planChangeSessionsService.findResumableWithEarlier(
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
  const copyFrom = (body as { copyFrom?: unknown })?.copyFrom;
  if (copyFrom !== undefined) {
    if (typeof copyFrom !== 'string' || !copyFrom.trim()) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`copyFrom` must be a session id.' },
        { status: 400 },
      );
    }
    const b = body as { body?: unknown; isAnswer?: unknown; anchorKey?: unknown; planId?: unknown };
    if (
      (b.body !== undefined && typeof b.body !== 'string') ||
      (b.anchorKey !== undefined && b.anchorKey !== null && typeof b.anchorKey !== 'string') ||
      (b.planId !== undefined && b.planId !== null && typeof b.planId !== 'string')
    ) {
      return NextResponse.json(
        {
          code: 'BAD_REQUEST',
          error: '`body`, `anchorKey` and `planId` must be strings when given.',
        },
        { status: 400 },
      );
    }
    try {
      const result = await planChangeSessionsService.startCopied(ctx, copyFrom.trim(), {
        body: b.body as string | undefined,
        isAnswer: b.isAnswer === true,
        anchorKey: (b.anchorKey as string | null | undefined) ?? null,
        planId: (b.planId as string | null | undefined) ?? null,
      });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (err) {
      const mapped = mapPlanChangeError(err);
      if (mapped) return mapped;
      throw err;
    }
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
