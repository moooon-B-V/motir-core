import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { contextualPlanningService } from '@/lib/services/contextualPlanningService';
import { mapContextualPlanError, noActiveProject } from './_errors';

// POST /api/work-items/[id]/ai/plan — open (or RESUME) the planning conversation
// ANCHORED at this work item and submit the turn as the scoped 7.11 job
// (7.12.3 · MOTIR-909). Returns `{ jobId, sessionId, session }`: the job the
// stream route below subscribes to, the thread it belongs to, and the thread as
// it now stands so the panel renders without a second read.
//
// MULTI-TARGET. The path item is the PRIMARY anchor; `targetKeys[]` in the body
// names ADDITIONAL anchors by identifier — what the @-mention picker inserts. The
// single-item entrance is simply the 1-element case. EVERY anchor is view-gated
// (6.4) inside the service before it becomes planning context; an item in another
// tenant, or in a project this actor cannot browse, 404s.
//
// The Re-plan "reason" is the `prompt` itself — the contract carries no separate
// reason field: motir-ai classifies the intent from the turn text (7.12.2).
//
// NO WRITE happens here. This submits and streams; the proposed delta is
// persisted only through the confirmation gate on the shipped approve route.
//
// HTTP only (CLAUDE.md 4-layer): parse, gate the session + active project, call
// ONE service method, map typed errors.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const { id } = await params;

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

  // Parsed defensively: a non-array, or entries that are not strings, are a
  // malformed request rather than something to coerce — silently dropping a
  // target the user picked would plan against a set they never asked for.
  const rawTargets = (body as { targetKeys?: unknown })?.targetKeys;
  if (rawTargets !== undefined && !Array.isArray(rawTargets)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`targetKeys` must be an array of work-item identifiers.' },
      { status: 400 },
    );
  }
  const targetKeys = (rawTargets ?? []) as unknown[];
  if (targetKeys.some((k) => typeof k !== 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`targetKeys` must contain only work-item identifiers.' },
      { status: 400 },
    );
  }

  try {
    const result = await contextualPlanningService.planFromWorkItem(
      { anchorId: id, targetKeys: targetKeys as string[], prompt },
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapContextualPlanError(err);
    if (mapped) return mapped;
    throw err;
  }
}
