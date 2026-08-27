import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/projects/[key]/lessons/[lessonId] (Subtask MOTIR-3337 · Story
// MOTIR-3329) — one lesson in full: what happened, why it matters, how to apply
// it, its routing axes, its provenance and its dates. The screen that answers
// "why is the planner telling me this?", so it carries the reasoning rather
// than a summary of it.
//
// Same gate, same order, same reason as the list: the permission is asserted
// inside the service BEFORE anything crosses the boundary.
//
// ⚠️ A lesson belonging to ANOTHER project is a 404 with the same body as an
// unknown id, because motir-ai raises the same `not_found` for both and nothing
// on this side tries to tell them apart. Anything else would make the route an
// existence oracle for other tenants' lesson ids.

interface RouteParams {
  params: Promise<{ key: string; lessonId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key, lessonId } = await params;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const lesson = await projectLessonsService.getLesson(project.id, ctx, lessonId);
    if (!lesson) {
      return NextResponse.json({ code: 'NOT_FOUND', error: 'No such lesson.' }, { status: 404 });
    }
    return NextResponse.json(lesson);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
