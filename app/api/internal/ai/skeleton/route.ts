import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// GET /api/internal/ai/skeleton (Subtask 7.5.1) — the plan-tree BREADTH
// projection, re-exposed as a NAMED tool in the 7.5 graph-traversal family so
// the planner has one coherent tool surface (get_item / get_subtree /
// walk_blocking / skeleton). No new query — it is the SAME read the 7.1.6
// `plan-tree` endpoint serves (`aiBoundaryService.readPlanTree`), which stays.
// Same job-scoped-token auth + 404-not-403 tenant posture as the rest of the
// family; thin transport per CLAUDE.md.
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  try {
    const tree = await aiBoundaryService.readPlanTree(auth.projectId, auth.ctx);
    return NextResponse.json(tree);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
