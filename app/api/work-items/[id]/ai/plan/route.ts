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
//
// MOTIR-910 added the two NON-submitting halves the entrance needs, additively:
// a `GET` that RESUMES the item's thread (so re-opening the workspace shows the
// conversation already had), and a `{ resubmit: true }` POST body that re-sends
// the ACCUMULATED intent without appending a turn (the rail's Retry after a
// failed run). Neither changes the shipped submit contract: a body carrying a
// `prompt` behaves exactly as before, and a body carrying neither is still 400.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  const { id } = await params;
  const parsed = parseTargetKeys(new URL(req.url).searchParams.getAll('targetKey'));
  if ('error' in parsed) return parsed.error;

  try {
    const result = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: id, targetKeys: parsed.targetKeys },
      ctx,
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapContextualPlanError(err);
    if (mapped) return mapped;
    throw err;
  }
}

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
  // A RESUBMIT carries no new words — it re-sends what the thread already
  // accumulated (the rail's Retry). Everything else still requires a prompt.
  const resubmit = (body as { resubmit?: unknown })?.resubmit === true;
  if (!prompt && !resubmit) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`prompt` is required.' },
      { status: 400 },
    );
  }

  const parsed = parseTargetKeys((body as { targetKeys?: unknown })?.targetKeys);
  if ('error' in parsed) return parsed.error;

  try {
    const result = resubmit
      ? await contextualPlanningService.resubmitFromWorkItem(
          { anchorId: id, targetKeys: parsed.targetKeys },
          ctx,
        )
      : await contextualPlanningService.planFromWorkItem(
          { anchorId: id, targetKeys: parsed.targetKeys, prompt },
          ctx,
        );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapContextualPlanError(err);
    if (mapped) return mapped;
    throw err;
  }
}

/**
 * The ADDITIONAL anchors, parsed defensively: a non-array, or entries that are
 * not strings, are a malformed request rather than something to coerce —
 * silently dropping a target the user picked would plan against a set they never
 * asked for. Shared by all three verbs so one shape can never diverge.
 */
function parseTargetKeys(raw: unknown): { targetKeys: string[] } | { error: NextResponse } {
  if (raw !== undefined && !Array.isArray(raw)) {
    return {
      error: NextResponse.json(
        { code: 'BAD_REQUEST', error: '`targetKeys` must be an array of work-item identifiers.' },
        { status: 400 },
      ),
    };
  }
  const keys = (raw ?? []) as unknown[];
  if (keys.some((k) => typeof k !== 'string')) {
    return {
      error: NextResponse.json(
        { code: 'BAD_REQUEST', error: '`targetKeys` must contain only work-item identifiers.' },
        { status: 400 },
      ),
    };
  }
  return { targetKeys: keys as string[] };
}
