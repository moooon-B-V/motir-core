import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { MotirAiError } from '@/lib/ai/errors';
import { InvalidDesignChoiceError } from '@/lib/ai/preplanErrors';

// GET /api/ai/pre-plan (Subtask 7.3.70) — the resumable pre-plan read the
// discovery UI (7.3.5) loads its state from: the session strategy decisions +
// each artifact's forward revision log + the per-revision diffs, for the active
// project.
//
// Thin HTTP layer over aiPreplanService (CLAUDE.md 4-layer): read the session
// (getSession → 401) + the active-project context (getActiveProject, the project
// analogue of getSession — mirrors /api/ai/chat + /api/board), call ONE service
// method, map typed errors to status codes. No `db` / no `motir-ai` import here —
// the open-core boundary lives in the `server-only` client the service calls.
//
// Project comes from the active-project context (server-resolved within the
// actor's own workspace), never the client — so a cross-tenant project is
// unreachable; a null context is simply "no active project" → 404 (the
// no-existence-leak shape, finding #26). A not-yet-started pre-plan is NOT an
// error: motir-ai returns the empty state ({ session: null, docs: [] }) and this
// route serializes it as a 200. Only a motir-ai transport / upstream failure
// maps to 502 (the dependency failed, not the caller) — never a misleading empty.

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  try {
    const state = await aiPreplanService.getPreplanState(ctx);
    return NextResponse.json(state, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    // Any motir-ai-side failure (unreachable / misconfigured / rejected) maps
    // through the 7.1.1 taxonomy to a typed error → 502: the upstream dependency
    // failed, not the caller's request.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}

// PATCH /api/ai/pre-plan (Subtask 7.3.81) — persist the onboarding design choice
// the user picked in the design step (MOTIR-1040), so re-entering the step (or
// resuming on a later visit) restores the saved look. Same thin HTTP layer +
// gates as the GET (getSession → 401, getActiveProject → 404 no-existence-leak),
// one service call.
//
// The body carries only `{ designChoice: { styleId, paletteId, typeId } }` — the
// three axes. A malformed body (missing/!object/non-string axis) is a 400 before
// the service runs; an axis whose id is not a known motir-core registry id is a
// 422 (InvalidDesignChoiceError — motir-core owns the registries). Only a
// motir-ai transport / upstream failure maps to 502. The Theme toggle is a
// preview mode, NOT an axis, and is never sent here.

export async function PATCH(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json(
      { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
      { status: 404 },
    );
  }

  const body: unknown = await req.json().catch(() => null);
  const dc = (body as { designChoice?: unknown } | null)?.designChoice;
  if (
    !dc ||
    typeof dc !== 'object' ||
    Array.isArray(dc) ||
    typeof (dc as Record<string, unknown>).styleId !== 'string' ||
    typeof (dc as Record<string, unknown>).paletteId !== 'string' ||
    typeof (dc as Record<string, unknown>).typeId !== 'string'
  ) {
    return NextResponse.json(
      { code: 'INVALID_BODY', error: 'Expected { designChoice: { styleId, paletteId, typeId } }.' },
      { status: 400 },
    );
  }
  const axes = dc as { styleId: string; paletteId: string; typeId: string };

  try {
    const designChoice = await aiPreplanService.saveDesignChoice(ctx, {
      styleId: axes.styleId,
      paletteId: axes.paletteId,
      typeId: axes.typeId,
    });
    return NextResponse.json(
      { designChoice },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    // An unknown axis id is the caller's bug (motir-core owns the registries) → 422.
    if (err instanceof InvalidDesignChoiceError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    // Any motir-ai-side failure maps through the 7.1.1 taxonomy → 502.
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
