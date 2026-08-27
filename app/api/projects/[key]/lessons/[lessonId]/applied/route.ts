import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import {
  MotirAiConfigError,
  MotirAiJobNotFoundError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// PUT /api/projects/[key]/lessons/[lessonId]/applied (Subtask MOTIR-3345 ·
// Story MOTIR-3330) — the one decision this surface offers: whether Motir is
// applying this lesson.
//
// ONE route for both directions, keyed on `{ applied: boolean }`, because they
// are one axis and not two operations. Two endpoints would need the CALLER to
// know which one a given row wants, and which value `Apply again` should land on
// is exactly the state machine the upstream deliberately keeps server-side
// (MOTIR-3344: clear the retirement, or exempt the row from the clock).
//
// Thin transport per CLAUDE.md: session context, resolve the project by key,
// call ONE service method, map typed errors.
//
// ⚠️ THE PERMISSION IS `lesson:manage`, AND IT IS CHECKED IN THE SERVICE before
// anything crosses the boundary — the same order the reads use, for the same
// reason (`projectLessonsService`, and the call-count assertion in the tests).
// `lesson:view` does NOT satisfy it: the two keys exist so a role can read the
// library without changing what the planner tells everybody.
//
// Typed errors → status codes:
//   ProjectNotFoundError    → 404 (missing / cross-tenant / non-browsable)
//   PermissionDeniedError   → 403, carrying `lesson:manage` so the surface can
//                                  say WHICH permission is missing
//   MotirAiJobNotFoundError → 404 — the upstream `not_found`, which covers an
//                                  unknown id, another project's lesson AND a
//                                  GLOBAL one, deliberately in the same words
//   MotirAiConfigError      → 503 `AI_NOT_CONFIGURED`
//   MotirAiUnavailableError → 503 `AI_UNAVAILABLE`
//
// ⚠️ AND UNLIKE THE READS, THIS DOES NOT DEGRADE QUIETLY. A read goes quiet on a
// motir-ai outage so an unrelated service cannot cost a customer their settings
// page. A WRITE that swallowed the same failure would tell the user their lesson
// was retired when nothing happened, and the row would flip back on the next
// read — so the outage arms answer 503 with a code the surface can render.

interface RouteParams {
  params: Promise<{ key: string; lessonId: string }>;
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key, lessonId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'INVALID_BODY', error: 'Body must be valid JSON.' },
      { status: 400 },
    );
  }
  const applied = (body as { applied?: unknown } | null)?.applied;
  if (typeof applied !== 'boolean') {
    return NextResponse.json(
      { code: 'INVALID_BODY', error: "'applied' must be a boolean." },
      { status: 400 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const lesson = await projectLessonsService.setLessonApplied(project.id, ctx, lessonId, applied);
    return NextResponse.json(lesson);
  } catch (err) {
    // ⚠️ The upstream arms are matched BEFORE the shared project mapper, which
    // returns null for them and would otherwise let a deliberate refusal escape
    // as a 500. A refusal the product CHOSE, rendered to a user as "something
    // went wrong", is a design failure one layer down.
    if (err instanceof MotirAiJobNotFoundError) {
      return NextResponse.json({ code: 'NOT_FOUND', error: 'No such lesson.' }, { status: 404 });
    }
    if (err instanceof MotirAiConfigError) {
      return NextResponse.json(
        { code: 'AI_NOT_CONFIGURED', error: 'Motir AI is not connected.' },
        { status: 503 },
      );
    }
    if (err instanceof MotirAiUnavailableError) {
      return NextResponse.json(
        { code: 'AI_UNAVAILABLE', error: 'Motir AI could not be reached.' },
        { status: 503 },
      );
    }
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
