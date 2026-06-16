import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { aiJobsService } from '@/lib/services/aiJobsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { MotirAiError } from '@/lib/ai/errors';

// Dev/internal trigger for the `noop` walking skeleton (Subtask 7.1.7). It lets
// an operator drive the full boundary loop — submit → ai worker → read-back →
// empty persist → succeeded — without any product UI.
//
// "Not exposed in production UI": there is NO UI affordance, the route lives
// under /api/internal/ai/dev/, it requires a signed-in session, AND it is gated
// behind the AI_DEV_TRIGGER env flag (default OFF → 404, as if the route does
// not exist). Flip the flag to run the live loop, then unset it.
//
//   POST /api/internal/ai/dev/noop?project=PROD   → { jobId }
//   GET  /api/internal/ai/dev/noop?jobId=<id>     → { jobId, status, result?, error? }

function devEnabled(): boolean {
  return process.env['AI_DEV_TRIGGER'] === '1';
}

export async function POST(req: Request): Promise<Response> {
  if (!devEnabled()) return new NextResponse(null, { status: 404 });

  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const projectKey = new URL(req.url).searchParams.get('project');
  if (!projectKey) {
    return NextResponse.json({ code: 'PROJECT_KEY_REQUIRED' }, { status: 400 });
  }

  try {
    const { jobId } = await aiJobsService.submitNoopJob(projectKey, ctx);
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof MotirAiError) {
      // The downstream service (motir-ai) failed or is unreachable.
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!devEnabled()) return new NextResponse(null, { status: 404 });

  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const jobId = new URL(req.url).searchParams.get('jobId');
  if (!jobId) {
    return NextResponse.json({ code: 'JOB_ID_REQUIRED' }, { status: 400 });
  }

  try {
    const view = await aiJobsService.getJobStatus(jobId);
    return NextResponse.json({
      jobId: view.jobId,
      status: view.status,
      result: view.result,
      error: view.error ? { code: view.error.code, message: view.error.message } : null,
    });
  } catch (err) {
    if (err instanceof MotirAiError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 502 });
    }
    throw err;
  }
}
