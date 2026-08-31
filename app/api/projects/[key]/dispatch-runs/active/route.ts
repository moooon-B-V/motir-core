import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// GET /api/projects/[key]/dispatch-runs/active (Story MOTIR-1789 · MOTIR-1793) —
// every LIVE run in the project, with its legs' keys and dispositions, in ONE
// request.
//
// ⚠️ ONE READ FOR A WHOLE LIST, and that is the point rather than a convenience.
// The consumer is `/ready`, and a per-card *"is there a live run?"* endpoint
// would be one request per ready row — an N+1 acquired on the busiest surface in
// the product, and the kind that looks fine with three rows.
//
// It is also what stops two surfaces disagreeing about what *active* means: the
// alternative is each of them filtering a paginated history client-side.
//
// Not paginated, deliberately: the population is bounded by how many runs one
// project has IN FLIGHT, which is a handful — unlike the history read beside it,
// which is unbounded and is.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { key } = await params;
  try {
    return NextResponse.json({
      runs: await dispatchRunService.listActiveRunsForProject(key, gate.ctx),
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
