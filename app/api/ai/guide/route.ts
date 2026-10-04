import { NextResponse } from 'next/server';

import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { getActiveProject } from '@/lib/projects';
import { aiGuideService } from '@/lib/services/aiGuideService';
import {
  invalidAttachmentIds,
  mapPlanChangeError,
  noActiveProject,
  readAttachmentIds,
  readSessionId,
} from '../plan-change/_errors';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';

// POST /api/ai/guide — the GUIDE ME THROUGH door (Story MOTIR-7459 · MOTIR-7464;
// contract in `docs/decisions/conversation-turn-intent.md` AMENDMENT 2).
//
// Three bodies, one door:
//   { itemKey, text? }                — OPEN the guide conversation on a manual
//                                       card. On a card with to-do rows the
//                                       member's latest guide conversation is
//                                       resumed and nothing is sent; otherwise a
//                                       new one starts with the opening turn
//                                       (`text`, or "Guide me through <KEY>."),
//                                       and its `guide_work_item` job runs.
//   { sessionId, text, attachmentIds? } — the person's next turn in that
//                                       conversation. `attachmentIds` (MOTIR-7484;
//                                       `guide-turn-files.md` A3.2) are up to four
//                                       attachments ALREADY on the guided card —
//                                       uploaded first through the shipped
//                                       attachment route — and `text` may then be
//                                       empty. (The overlay may equally
//                                       post it to `POST /api/ai/ask` with the
//                                       `sessionId`: the server reads the
//                                       session's origin and lands it here.)
//   { sessionId, turnId }             — RE-RUN a turn already on the thread, the
//                                       retry after a failed submit. Replay-safe:
//                                       a turn that already has a job submits
//                                       nothing new.
//
// No `intent` is read from any body (ADR §1): the door, through the session's
// origin, is what makes a turn a guide turn.
//
// HTTP only (CLAUDE.md 4-layer): parse, call ONE service method, map typed
// errors. No `db`, no `$transaction`, no `motir-ai` import.
export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const ctx = await getActiveProject();
  if (!ctx) return noActiveProject();

  // A guide turn is metered like an ask turn (A2.8): the `ai:generate` bucket at
  // the door, spent before the body is read.
  const limited = await enforceAiRateLimit(ctx, 'ai:generate');
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Invalid JSON body.' }, { status: 400 });
  }
  const body = (raw ?? {}) as {
    itemKey?: unknown;
    text?: unknown;
    turnId?: unknown;
    sessionId?: unknown;
    attachmentIds?: unknown;
  };
  if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`text` must be a string.' },
      { status: 400 },
    );
  }
  const text = typeof body.text === 'string' ? body.text : undefined;
  const sessionId = readSessionId(body.sessionId) ?? undefined;
  const attachmentIds = readAttachmentIds(body.attachmentIds);
  if (attachmentIds === 'invalid') return invalidAttachmentIds();

  try {
    if (typeof body.turnId === 'string' && body.turnId.length > 0) {
      if (!sessionId) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`sessionId` is required with `turnId`.' },
          { status: 400 },
        );
      }
      const result = await aiGuideService.resubmit(body.turnId, ctx, { sessionId });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (sessionId) {
      if (text === undefined && attachmentIds.length === 0) {
        return NextResponse.json(
          { code: 'BAD_REQUEST', error: '`text` is required with `sessionId`.' },
          { status: 400 },
        );
      }
      const result = await aiGuideService.submitTurn(text ?? '', ctx, {
        sessionId,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    // Files ride a turn on an open conversation, never the door's opening turn.
    if (attachmentIds.length > 0) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`attachmentIds` needs a `sessionId`.' },
        { status: 400 },
      );
    }
    if (typeof body.itemKey !== 'string' || body.itemKey.trim().length === 0) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`itemKey` is required.' },
        { status: 400 },
      );
    }
    const result = await aiGuideService.open(body.itemKey.trim(), ctx, {
      ...(text !== undefined ? { text } : {}),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (mapped) return mapped;
    throw err;
  }
}
